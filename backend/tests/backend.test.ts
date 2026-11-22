import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AppDeps } from "../src/context.js";
import type { SealmsCollections } from "../src/db/client.js";
import type {
  AuthNonceDoc,
  BlockedOwnerDoc,
  CounterDoc,
  InviteCodeDoc,
  SealmDoc,
} from "../src/db/types.js";
import {
  computeServerHash,
  decryptApiKey,
  encryptApiKey,
  generateInviteCode,
} from "../src/lib/crypto.js";
import {
  parseServerProperties,
  propertiesToRealmsOptions,
  updateServerProperties,
} from "../src/lib/properties.js";
import { createRateLimiter } from "../src/lib/ratelimit.js";
import { PteroAuthError, type PteroClient } from "../src/lib/ptero.js";
import { isPrivateIp, validatePanelUrl } from "../src/lib/ssrf.js";

const TEST_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_JWT_SECRET = "super-secret-sealms-jwt-signing-key-for-tests";

// Minimal in-memory Mongo-like collection for fast hermetic route tests
function createMockCollection<T extends object>(initial: T[] = []) {
  const items: T[] = [...initial];

  function matches(doc: object, filter: Record<string, unknown>): boolean {
    const rec = doc as Record<string, unknown>;
    for (const [key, cond] of Object.entries(filter)) {
      if (key === "$or" && Array.isArray(cond)) {
        if (!cond.some((sub) => matches(rec, sub as Record<string, unknown>))) return false;
        continue;
      }
      const val = getNested(rec, key);
      if (cond && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof ObjectId)) {
        const c = cond as Record<string, unknown>;
        if ("$gt" in c) {
          if (!(val instanceof Date) || !(val.getTime() > (c.$gt as Date).getTime())) return false;
        } else if ("$elemMatch" in c) {
          if (!Array.isArray(val)) return false;
          if (!val.some((el) => matches(el as Record<string, unknown>, c.$elemMatch as Record<string, unknown>))) {
            return false;
          }
        } else {
          if (val !== cond) return false;
        }
      } else {
        if (Array.isArray(val)) {
          if (!val.includes(cond)) return false;
        } else if (val !== cond) {
          return false;
        }
      }
    }
    return true;
  }

  function getNested(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      if (Array.isArray(cur)) {
        return cur.map((item) => (item as Record<string, unknown>)[p]);
      }
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }

  function setNested(obj: Record<string, unknown>, path: string, value: unknown) {
    const parts = path.split(".");
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }

  function applyUpdate(doc: object, filter: Record<string, unknown>, update: Record<string, unknown>) {
    const target = doc as Record<string, unknown>;
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
        if (k.includes(".$.")) {
          const [arrPath, field] = k.split(".$.");
          const arr = getNested(target, arrPath) as Record<string, unknown>[];
          const elemFilter = (filter[arrPath] as { $elemMatch?: Record<string, unknown> })?.$elemMatch;
          const idx = arr.findIndex((item) => {
            if (elemFilter) return matches(item, elemFilter);
            const dotKey = Object.keys(filter).find((fk) => fk.startsWith(`${arrPath}.`));
            if (dotKey) {
              const subField = dotKey.slice(arrPath.length + 1);
              return item[subField] === filter[dotKey];
            }
            return false;
          });
          if (idx >= 0) arr[idx][field] = v;
        } else {
          setNested(target, k, v);
        }
      }
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
        const cur = (getNested(target, k) as number) ?? 0;
        setNested(target, k, cur + v);
      }
    }
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push as Record<string, unknown>)) {
        const arr = (getNested(target, k) as unknown[]) ?? [];
        arr.push(v);
        setNested(target, k, arr);
      }
    }
    if (update.$pull) {
      for (const [k, cond] of Object.entries(update.$pull as Record<string, Record<string, unknown>>)) {
        const arr = (getNested(target, k) as Record<string, unknown>[]) ?? [];
        setNested(target, k, arr.filter((item) => !matches(item, cond)));
      }
    }
  }

  return {
    items,
    async findOne(filter: Record<string, unknown>) {
      return items.find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, unknown> = {}) {
      const matched = items.filter((d) => matches(d, filter));
      return {
        sort() { return this; },
        async toArray() { return matched; },
      };
    },
    async countDocuments(filter: Record<string, unknown> = {}) {
      return items.filter((d) => matches(d, filter)).length;
    },
    async insertOne(doc: T) {
      const withId = { _id: new ObjectId(), ...doc };
      items.push(withId);
      return { insertedId: withId._id };
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, opts?: { upsert?: boolean }) {
      const found = items.find((d) => matches(d, filter));
      if (found) {
        applyUpdate(found, filter, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (opts?.upsert) {
        const created: Record<string, unknown> = { _id: new ObjectId() };
        if (update.$setOnInsert) Object.assign(created, update.$setOnInsert);
        applyUpdate(created, filter, update);
        items.push(created as T);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async deleteOne(filter: Record<string, unknown>) {
      const idx = items.findIndex((d) => matches(d, filter));
      if (idx >= 0) {
        items.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    async deleteMany(filter: Record<string, unknown>) {
      let deletedCount = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        if (matches(items[i], filter)) {
          items.splice(i, 1);
          deletedCount++;
        }
      }
      return { deletedCount };
    },
    async findOneAndDelete(filter: Record<string, unknown>) {
      const idx = items.findIndex((d) => matches(d, filter));
      if (idx >= 0) {
        const [removed] = items.splice(idx, 1);
        return removed;
      }
      return null;
    },
    async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, opts?: { upsert?: boolean }) {
      let found = items.find((d) => matches(d, filter));
      if (!found && opts?.upsert) {
        found = { ...filter } as T;
        items.push(found);
      }
      if (found) {
        applyUpdate(found, filter, update);
        return found;
      }
      return null;
    },
  };
}

function createTestHarness() {
  const collections = {
    sealms: createMockCollection<SealmDoc>(),
    authNonces: createMockCollection<AuthNonceDoc>(),
    invites: createMockCollection<InviteCodeDoc>(),
    blockedOwners: createMockCollection<BlockedOwnerDoc>(),
    counters: createMockCollection<CounterDoc>(),
  };

  let pteroState: "offline" | "starting" | "running" = "offline";
  let slpOnline = false;
  let serverProperties = "level-name=my_existing_world\ndifficulty=normal\ngamemode=survival\npvp=true\nmax-players=20\n";
  let whitelistJson = JSON.stringify([
    { uuid: "11111111-1111-1111-1111-111111111111", name: "ExistingFriend" },
  ]);
  const sentCommands: string[] = [];
  const powerSignals: string[] = [];

  const ptero: PteroClient = {
    getServerDetails: vi.fn(async (_url, apiKey, serverId) => {
      if (apiKey === "ptlc_revoked") throw new PteroAuthError(401);
      return {
        identifier: serverId,
        name: "My Ptero Server",
        description: "Test Server",
        limits: { memoryMb: 4096, diskMb: 10240, cpuPercent: 200 },
        primaryAllocation: { ip: "203.0.113.10", ipAlias: null, port: 25565, address: "203.0.113.10:25565" },
      };
    }),
    getResources: vi.fn(async (_url, apiKey) => {
      if (apiKey === "ptlc_revoked") throw new PteroAuthError(401);
      return {
        currentState: pteroState,
        isSuspended: false,
        memoryBytes: 1024 * 1024 * 1024,
        cpuAbsolute: 42.5,
        diskBytes: 2 * 1024 * 1024 * 1024,
        networkRxBytes: 50000,
        networkTxBytes: 90000,
        uptimeMs: 120_000,
      };
    }),
    sendPowerSignal: vi.fn(async (_url, apiKey, _id, signal) => {
      if (apiKey === "ptlc_revoked") throw new PteroAuthError(401);
      powerSignals.push(signal);
      if (signal === "start") pteroState = "starting";
      if (signal === "stop") pteroState = "offline";
    }),
    sendCommand: vi.fn(async (_url, _key, _id, cmd) => {
      sentCommands.push(cmd);
    }),
    listBackups: vi.fn(async () => [
      { uuid: "bk-1", name: "Daily", bytes: 123456, createdAt: "2026-11-22T12:00:00Z", isSuccessful: true, isLocked: false },
    ]),
    restoreBackup: vi.fn(async () => {}),
    createBackup: vi.fn(async () => ({
      uuid: "bk-2", name: "New", bytes: 0, createdAt: "2026-11-22T13:00:00Z", isSuccessful: true, isLocked: false,
    })),
    readFile: vi.fn(async (_url, _key, _id, path) => {
      if (path === "/server.properties") return serverProperties;
      if (path === "/whitelist.json") return whitelistJson;
      return "";
    }),
    writeFile: vi.fn(async (_url, _key, _id, path, content) => {
      if (path === "/server.properties") serverProperties = content;
    }),
    listFiles: vi.fn(async (_url, _key, _id, dir) => {
      if (dir === "/world") {
        return [{ name: "NestedMapFolder", isFile: false, size: 0, modifiedAt: "" }];
      }
      if (dir === "/world/NestedMapFolder") {
        return [{ name: "level.dat", isFile: true, size: 512, modifiedAt: "" }];
      }
      return [];
    }),
    compressFiles: vi.fn(async () => ({ name: "world-backup.tar.gz" })),
    decompressFile: vi.fn(async () => {}),
    deleteFiles: vi.fn(async () => {}),
    renameFiles: vi.fn(async () => {}),
    createFolder: vi.fn(async () => {}),
    getSignedDownloadUrl: vi.fn(async () => "https://wings.example.com/download?token=abc"),
    getSignedUploadUrl: vi.fn(async () => "https://wings.example.com/upload?token=xyz"),
  };

  const config: AppConfig = {
    mongodbUri: "mongodb://mock",
    mongodbDbName: "sealms_test",
    jwtSecret: TEST_JWT_SECRET,
    encryptionKey: TEST_ENC_KEY,
    publicBaseUrl: "https://mcsealms.vercel.app",
    port: 3000,
    maxSealmsPerOwner: 10,
    maxActiveInviteCodesPerSealm: 10,
    maxWhitelistImport: 50,
    maxDailyPendingInvites: 50,
    allowInsecureLocalPanelUrls: true,
  };

  const deps: AppDeps = {
    config,
    getCollections: async () => collections as unknown as SealmsCollections,
    mojang: {
      verifyHasJoined: vi.fn(async (username: string) => {
        if (username === "OwnerUser") {
          return { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", username: "OwnerUser" };
        }
        if (username === "FriendUser") {
          return { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", username: "FriendUser" };
        }
        return null;
      }),
      lookupProfileByUsername: vi.fn(async (username: string) => {
        if (username === "FriendUser") {
          return { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", username: "FriendUser" };
        }
        return null;
      }),
    },
    ptero,
    rateLimiter: createRateLimiter(),
    pingServer: vi.fn(async () => ({ online: slpOnline })),
  };

  const app = createApp(deps);

  async function loginAs(username: string): Promise<string> {
    const ch = await app.request("/sealms/auth/challenge", { method: "POST" });
    const { serverId } = (await ch.json()) as { serverId: string };
    const vr = await app.request("/sealms/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, serverId }),
    });
    const data = (await vr.json()) as { token: string };
    return data.token;
  }

  return {
    app,
    collections,
    ptero,
    loginAs,
    sentCommands,
    powerSignals,
    setPteroState: (s: "offline" | "starting" | "running") => { pteroState = s; },
    setSlpOnline: (v: boolean) => { slpOnline = v; },
    getServerProperties: () => serverProperties,
  };
}

describe("Sealms Crypto & Security Primitives", () => {
  it("encrypts and decrypts ptlc_ keys with AES-256-GCM", () => {
    const encrypted = encryptApiKey("ptlc_secret_key_12345", TEST_ENC_KEY);
    expect(encrypted.split(":")).toHaveLength(3);
    expect(encrypted).not.toContain("ptlc_secret_key_12345");
    expect(decryptApiKey(encrypted, TEST_ENC_KEY)).toBe("ptlc_secret_key_12345");
  });

  it("computes deterministic serverHash", () => {
    const h1 = computeServerHash("https://Panel.Example.com/", "AbCd1234");
    const h2 = computeServerHash("https://panel.example.com", "abcd1234");
    expect(h1).toBe(h2);
  });

  it("generates SLM-XXXXX invite codes", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^SLM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  });

  it("blocks private IPs and non-HTTPS URLs in SSRF protection", async () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);

    await expect(validatePanelUrl("http://panel.example.com")).rejects.toThrow("https://");
    await expect(
      validatePanelUrl("https://internal.example.com", {
        dnsLookup: async () => [{ address: "10.0.0.1" }],
      })
    ).rejects.toThrow("private");
    await expect(
      validatePanelUrl("https://panel.example.com", {
        dnsLookup: async () => [{ address: "93.184.216.34" }],
      })
    ).resolves.toBeInstanceOf(URL);
  });

  it("parses and updates server.properties with live commands vs restart detection", () => {
    const raw = "# comment\nlevel-name=world\ndifficulty=normal\npvp=true\n";
    const parsed = parseServerProperties(raw);
    expect(propertiesToRealmsOptions(parsed.values).difficulty).toBe(2);

    const liveRes = updateServerProperties(raw, { difficulty: "hard" });
    expect(liveRes.liveCommands).toEqual(["difficulty hard"]);
    expect(liveRes.requiresRestart).toBe(false);

    const restartRes = updateServerProperties(raw, { "level-name": "world_slot_2" });
    expect(restartRes.requiresRestart).toBe(true);
    expect(restartRes.content).toContain("level-name=world_slot_2");
  });
});

describe("Sealms End-to-End API Flows", () => {
  it("completes auth, links a server, binds Slot 1, and blocks duplicate link", async () => {
    const h = createTestHarness();
    const ownerToken = await h.loginAs("OwnerUser");

    // Vanilla compatibility checks
    expect(await (await h.app.request("/mco/available")).text()).toBe("true");
    expect(await (await h.app.request("/mco/client/compatible")).text()).toBe("COMPATIBLE");

    // Link server with opt-in whitelist import
    const linkRes = await h.app.request("/sealms", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        panelUrl: "https://panel.example.com",
        apiKey: "ptlc_valid_key",
        serverId: "a1b2c3d4",
        importWhitelist: true,
      }),
    });
    expect(linkRes.status).toBe(201);
    const linked = (await linkRes.json()) as {
      sealm: { id: number; name: string };
      importedPendingInvites: number;
    };
    expect(linked.sealm.id).toBe(1);
    expect(linked.importedPendingInvites).toBe(1);
    expect(h.collections.sealms.items[0].slots[1].levelName).toBe("my_existing_world");

    // Duplicate server lock
    const dupRes = await h.app.request("/sealms", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        panelUrl: "https://panel.example.com",
        apiKey: "ptlc_valid_key",
        serverId: "a1b2c3d4",
      }),
    });
    expect(dupRes.status).toBe(409);
  });

  it("orchestrates seamless 503 auto-start -> starting -> SLP readiness -> 200 OK", async () => {
    const h = createTestHarness();
    const ownerToken = await h.loginAs("OwnerUser");

    await h.app.request("/sealms", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        panelUrl: "https://panel.example.com",
        apiKey: "ptlc_valid_key",
        serverId: "srv00001",
      }),
    });

    // 1. Offline -> triggers start & returns 503 Retry-After: 5
    const r1 = await h.app.request("/worlds/v1/1/join/pc", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r1.status).toBe(503);
    expect(r1.headers.get("Retry-After")).toBe("5");
    expect(h.powerSignals).toContain("start");

    // 2. Starting -> returns 503 Retry-After: 5
    const r2 = await h.app.request("/worlds/v1/1/join/pc", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r2.status).toBe(503);

    // 3. Running but world still loading (SLP false) -> returns 503 Retry-After: 3
    h.setPteroState("running");
    const r3 = await h.app.request("/worlds/v1/1/join/pc", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r3.status).toBe(503);
    expect(r3.headers.get("Retry-After")).toBe("3");

    // 4. SLP succeeds -> returns 200 OK with address
    h.setSlpOnline(true);
    const r4 = await h.app.request("/worlds/v1/1/join/pc", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r4.status).toBe(200);
    const joinData = (await r4.json()) as { address: string };
    expect(joinData.address).toBe("203.0.113.10:25565");
  });

  it("handles invite codes, OP permissions, resources tab, nested upload-complete, and web pages", async () => {
    const h = createTestHarness();
    const ownerToken = await h.loginAs("OwnerUser");
    const friendToken = await h.loginAs("FriendUser");

    await h.app.request("/sealms", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        panelUrl: "https://panel.example.com",
        apiKey: "ptlc_valid_key",
        serverId: "srv00002",
      }),
    });

    // Generate invite code
    const codeRes = await h.app.request("/sealms/1/invites/code", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ maxUses: 5 }),
    });
    expect(codeRes.status).toBe(201);
    const { code, url } = (await codeRes.json()) as { code: string; url: string };

    // Public invite HTML page has OpenGraph tags
    const htmlRes = await h.app.request(`/invite/${code}`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("og:title");
    expect(html).toContain(code);

    // Friend redeems full URL
    const redeemRes = await h.app.request("/sealms/invites/redeem", {
      method: "POST",
      headers: { Authorization: `Bearer ${friendToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: url }),
    });
    expect(redeemRes.status).toBe(200);
    expect(h.sentCommands).toContain("whitelist add FriendUser");

    // Non-OP member cannot view resources
    const deniedRes = await h.app.request("/sealms/1/resources", {
      headers: { Authorization: `Bearer ${friendToken}` },
    });
    expect(deniedRes.status).toBe(403);

    // Owner promotes Friend to OP -> now Friend can view resources
    const opRes = await h.app.request("/ops/1/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(opRes.status).toBe(200);
    expect(h.sentCommands).toContain("op FriendUser");

    const opResourcesRes = await h.app.request("/sealms/1/resources", {
      headers: { Authorization: `Bearer ${friendToken}` },
    });
    expect(opResourcesRes.status).toBe(200);
    const metrics = (await opResourcesRes.json()) as { cpuPercent: number; role: string };
    expect(metrics.cpuPercent).toBe(42.5);
    expect(metrics.role).toBe("operator");

    // Upload-complete detects nested level.dat one subfolder deep
    const upRes = await h.app.request("/sealms/1/upload-complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "custom.zip", slot: 1 }),
    });
    expect(upRes.status).toBe(200);
    const upData = (await upRes.json()) as { levelName: string };
    expect(upData.levelName).toBe("my_existing_world");

    // Privacy policy route
    const privRes = await h.app.request("/privacy");
    expect(privRes.status).toBe(200);
    expect(await privRes.text()).toContain("AES-256-GCM");
  });
});
