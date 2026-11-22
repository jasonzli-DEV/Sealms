import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { getNextNumericId } from "../db/client.js";
import type { SealmDoc, SealmMember } from "../db/types.js";
import {
  computeServerHash,
  encryptApiKey,
  generateInviteCode,
  normalizePanelUrl,
} from "../lib/crypto.js";
import { formatDashedUuid, isValidMinecraftUsername } from "../lib/mojang.js";
import { parseServerProperties, updateServerProperties } from "../lib/properties.js";
import { PteroAuthError } from "../lib/ptero.js";
import { mapSealmToRealmsServer } from "../lib/realmsMapper.js";
import { SsrfError, validatePanelUrl } from "../lib/ssrf.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimitByIp, rateLimitByUser } from "../middleware/ratelimit.js";
import { extractInviteCode, findSealmByNumericId, getUserRole, withPteroKey } from "./helpers.js";

const linkSealmSchema = z.object({
  panelUrl: z.string().min(8).max(256),
  apiKey: z.string().min(8).max(256),
  serverId: z.string().min(4).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(200).optional(),
  importWhitelist: z.boolean().optional().default(false),
});

const updateCredentialsSchema = z.object({
  apiKey: z.string().min(8).max(256),
});

const updateSettingsSchema = z.object({
  allowMemberWake: z.boolean().optional(),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(200).optional(),
});

const createInviteCodeSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().optional().default(null),
  expiresInHours: z.number().int().min(1).max(720).optional().default(168), // default 7 days
});

const redeemInviteSchema = z.object({
  code: z.string().min(3).max(256),
});

const uploadCompleteSchema = z.object({
  fileName: z.string().min(1).max(256),
  slot: z.number().int().min(1).max(3).optional(),
  minigame: z.boolean().optional().default(false),
  worldName: z.string().max(64).optional(),
});

export const sealmsRoutes = new Hono<AppEnv>();

// All /sealms/* routes except /sealms/auth/* require JWT auth
sealmsRoutes.use("/sealms", requireAuth);
sealmsRoutes.use("/sealms/invites/*", requireAuth);
sealmsRoutes.use("/sealms/:id/*", requireAuth);
sealmsRoutes.use("/sealms/:id", requireAuth);

// POST /sealms — Link a Pterodactyl server
sealmsRoutes.post("/sealms", rateLimitByUser("link-sealm", 10, 60), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null);
  const parsed = linkSealmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid link payload", details: parsed.error.flatten() }, 400);
  }

  const { config, getCollections, ptero } = c.get("deps");
  const { panelUrl, apiKey, serverId, importWhitelist } = parsed.data;

  // 1. SSRF validation
  let normalizedUrl: string;
  try {
    const validated = await validatePanelUrl(panelUrl, {
      allowInsecureLocal: config.allowInsecureLocalPanelUrls,
    });
    normalizedUrl = normalizePanelUrl(validated.toString());
  } catch (err) {
    if (err instanceof SsrfError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  const { sealms, counters, blockedOwners } = await getCollections();

  // 2. Owner cap check
  const ownedCount = await sealms.countDocuments({ ownerUuid: user.uuid });
  if (ownedCount >= config.maxSealmsPerOwner) {
    return c.json(
      { error: `You have reached the maximum of ${config.maxSealmsPerOwner} linked Sealms` },
      400
    );
  }

  // 3. Duplicate server lock
  const serverHash = computeServerHash(normalizedUrl, serverId);
  const existing = await sealms.findOne({ "ptero.serverHash": serverHash });
  if (existing) {
    return c.json({ error: "This Pterodactyl server is already linked to a Sealm" }, 409);
  }

  // 4. Live Pterodactyl verification
  let details;
  try {
    details = await ptero.getServerDetails(normalizedUrl, apiKey, serverId);
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json({ error: "Invalid Pterodactyl API key or missing permissions" }, 401);
    }
    return c.json({ error: "Could not connect to Pterodactyl server" }, 400);
  }

  // 5. Read server.properties to bind Slot 1 level-name
  let levelName = "world";
  try {
    const rawProps = await ptero.readFile(normalizedUrl, apiKey, serverId, "/server.properties");
    const props = parseServerProperties(rawProps);
    if (props.values["level-name"]) {
      levelName = props.values["level-name"];
    }
  } catch {
    // Default to "world" if server.properties doesn't exist yet
  }

  // 6. Optional opt-in whitelist import as Pending Invites (capped)
  const importedMembers: SealmMember[] = [];
  if (importWhitelist) {
    try {
      const rawWl = await ptero.readFile(normalizedUrl, apiKey, serverId, "/whitelist.json");
      const entries = JSON.parse(rawWl) as Array<{ uuid?: string; name?: string }>;
      if (Array.isArray(entries)) {
        const blockedList = await blockedOwners
          .find({ blockedOwnerUuid: user.uuid })
          .toArray();
        const blockedSet = new Set(blockedList.map((b) => b.playerUuid.toLowerCase()));

        for (const entry of entries) {
          if (importedMembers.length >= config.maxWhitelistImport) break;
          if (!entry.uuid || !entry.name || !isValidMinecraftUsername(entry.name)) continue;
          let dashed: string;
          try {
            dashed = formatDashedUuid(entry.uuid);
          } catch {
            continue;
          }
          if (dashed.toLowerCase() === user.uuid.toLowerCase()) continue;
          if (blockedSet.has(dashed.toLowerCase())) continue;
          if (importedMembers.some((m) => m.uuid === dashed)) continue;

          importedMembers.push({
            uuid: dashed,
            name: entry.name,
            operator: false,
            accepted: false, // Pending Invite only
            invitedAt: new Date(),
          });
        }
      }
    } catch {
      // whitelist.json may not exist yet
    }
  }

  const numericId = await getNextNumericId(counters);
  const encryptedApiKey = encryptApiKey(apiKey, config.encryptionKey);

  const doc: SealmDoc = {
    numericId,
    ownerUuid: user.uuid,
    ownerName: user.username,
    name: parsed.data.name || details.name || `Sealm #${numericId}`,
    description: parsed.data.description ?? details.description ?? "A Sealms Server",
    state: "OPEN",
    allowMemberWake: true,
    activeSlot: 1,
    slots: {
      1: { levelName, name: levelName },
      2: { levelName: "world_slot_2", name: "Slot 2" },
      3: { levelName: "world_slot_3", name: "Slot 3" },
    },
    ptero: {
      panelUrl: normalizedUrl,
      serverId,
      serverHash,
      encryptedApiKey,
      address: details.primaryAllocation?.address,
      credentialsInvalid: false,
    },
    members: importedMembers,
    createdAt: new Date(),
  };

  await sealms.insertOne(doc);

  return c.json(
    {
      sealm: mapSealmToRealmsServer(doc, user.uuid),
      importedPendingInvites: importedMembers.length,
    },
    201
  );
});

// PATCH /sealms/:id/credentials — Owner rotates/replaces revoked ptlc_ key
sealmsRoutes.patch("/sealms/:id/credentials", rateLimitByUser("ptero-write", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = updateCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid API key" }, 400);
  }

  const { config, ptero, getCollections } = c.get("deps");
  try {
    await ptero.getServerDetails(sealm.ptero.panelUrl, parsed.data.apiKey, sealm.ptero.serverId);
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json({ error: "New Pterodactyl API key is invalid or lacks permissions" }, 401);
    }
    return c.json({ error: "Failed to verify new credentials against panel" }, 400);
  }

  const encryptedApiKey = encryptApiKey(parsed.data.apiKey, config.encryptionKey);
  const { sealms } = await getCollections();
  await sealms.updateOne(
    { numericId: sealm.numericId },
    {
      $set: {
        "ptero.encryptedApiKey": encryptedApiKey,
        "ptero.credentialsInvalid": false,
      },
    }
  );

  return c.json({ updated: true });
});

// PATCH /sealms/:id/settings — Owner updates allowMemberWake / name / description
sealmsRoutes.patch("/sealms/:id/settings", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid settings payload" }, 400);
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.allowMemberWake !== undefined) update.allowMemberWake = parsed.data.allowMemberWake;
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.description !== undefined) update.description = parsed.data.description;

  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();
  if (Object.keys(update).length > 0) {
    await sealms.updateOne({ numericId: sealm.numericId }, { $set: update });
  }

  return c.json({ updated: true, ...update });
});

// DELETE /sealms/:id — Owner unlinks Sealm & wipes encrypted API key
sealmsRoutes.delete("/sealms/:id", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { getCollections } = c.get("deps");
  const { sealms, invites } = await getCollections();
  await sealms.deleteOne({ numericId: sealm.numericId });
  await invites.deleteMany({ sealmNumericId: sealm.numericId });

  return c.body(null, 204);
});

// GET /sealms/:id/resources — Owner/OP live Pterodactyl metrics
sealmsRoutes.get("/sealms/:id/resources", rateLimitByUser("ptero-read", 30, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);

  const role = getUserRole(sealm, user.uuid);
  if (role !== "owner" && role !== "operator") {
    return c.json({ error: "Owner or Operator permission required" }, 403);
  }

  const { ptero } = c.get("deps");
  try {
    const [details, resources] = await withPteroKey(c, sealm, (apiKey) =>
      Promise.all([
        ptero.getServerDetails(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId),
        ptero.getResources(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId),
      ])
    );

    return c.json({
      state: resources.currentState,
      isSuspended: resources.isSuspended,
      cpuPercent: resources.cpuAbsolute,
      cpuLimitPercent: details.limits.cpuPercent,
      memoryBytes: resources.memoryBytes,
      memoryLimitBytes: details.limits.memoryMb * 1024 * 1024,
      diskBytes: resources.diskBytes,
      diskLimitBytes: details.limits.diskMb * 1024 * 1024,
      networkRxBytes: resources.networkRxBytes,
      networkTxBytes: resources.networkTxBytes,
      uptimeMs: resources.uptimeMs,
      allowMemberWake: sealm.allowMemberWake,
      credentialsInvalid: false,
      role,
    });
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json(
        {
          error: "Pterodactyl API key is invalid or revoked",
          credentialsInvalid: true,
          role,
        },
        502
      );
    }
    throw err;
  }
});

// POST /sealms/:id/restart — Owner/OP sends restart signal
sealmsRoutes.post("/sealms/:id/restart", rateLimitByUser("ptero-power", 1, 10), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);

  const role = getUserRole(sealm, user.uuid);
  if (role !== "owner" && role !== "operator") {
    return c.json({ error: "Owner or Operator permission required" }, 403);
  }

  const { ptero } = c.get("deps");
  try {
    await withPteroKey(c, sealm, (apiKey) =>
      ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "restart")
    );
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json({ error: "Pterodactyl API key is invalid or revoked" }, 502);
    }
    throw err;
  }

  return c.json({ restarted: true });
});

// POST /sealms/:id/sync-whitelist — Reconcile manual /whitelist remove changes from Pterodactyl
sealmsRoutes.post("/sealms/:id/sync-whitelist", rateLimitByUser("ptero-read", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { ptero, getCollections } = c.get("deps");
  const rawWl = await withPteroKey(c, sealm, (apiKey) =>
    ptero.readFile(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "/whitelist.json")
  );

  let entries: Array<{ uuid?: string; name?: string }> = [];
  try {
    const parsed = JSON.parse(rawWl);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    return c.json({ error: "Could not parse whitelist.json" }, 400);
  }

  const whitelistedUuids = new Set(
    entries
      .map((e) => {
        try {
          return e.uuid ? formatDashedUuid(e.uuid) : null;
        } catch {
          return null;
        }
      })
      .filter((u): u is string => u !== null)
  );

  // Keep pending invites and members still in whitelist.json; remove accepted members removed from whitelist.json
  const keptMembers = sealm.members.filter(
    (m) => !m.accepted || whitelistedUuids.has(m.uuid.toLowerCase())
  );
  const removedCount = sealm.members.length - keptMembers.length;

  const { sealms } = await getCollections();
  await sealms.updateOne(
    { numericId: sealm.numericId },
    { $set: { members: keptMembers } }
  );

  return c.json({
    synced: true,
    removedCount,
    memberCount: keptMembers.length,
  });
});

// POST /sealms/:id/upload-complete — Decompress uploaded world .zip, detect nested level.dat, bind level-name
sealmsRoutes.post("/sealms/:id/upload-complete", rateLimitByUser("ptero-write", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = uploadCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid upload completion payload" }, 400);
  }

  const { fileName, minigame, worldName } = parsed.data;
  const targetSlot = parsed.data.slot ?? sealm.activeSlot;
  const baseFolder = minigame
    ? "sealm_minigame"
    : sealm.slots[targetSlot]?.levelName || (targetSlot === 1 ? "world" : `world_slot_${targetSlot}`);

  const { ptero, getCollections } = c.get("deps");

  const finalLevelName = await withPteroKey(c, sealm, async (apiKey) => {
    // Ensure clean target folder and decompress into it
    try {
      await ptero.deleteFiles(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "/", [baseFolder]);
    } catch {
      // May not exist yet
    }
    await ptero.createFolder(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "/", baseFolder);
    await ptero.renameFiles(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "/", [
      { from: fileName, to: `${baseFolder}/${fileName}` },
    ]);
    await ptero.decompressFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      `/${baseFolder}`,
      fileName
    );
    await ptero.deleteFiles(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      `/${baseFolder}`,
      [fileName]
    );

    // Inspect directory for nested level.dat (one subfolder deep)
    const entries = await ptero.listFiles(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      `/${baseFolder}`
    );
    let resolvedLevelName = baseFolder;
    const hasTopLevelDat = entries.some((e) => e.isFile && e.name === "level.dat");
    if (!hasTopLevelDat) {
      const subDirs = entries.filter((e) => !e.isFile && !e.name.startsWith("__MACOSX"));
      for (const dir of subDirs) {
        const subEntries = await ptero.listFiles(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `/${baseFolder}/${dir.name}`
        );
        if (subEntries.some((e) => e.isFile && e.name === "level.dat")) {
          resolvedLevelName = `${baseFolder}/${dir.name}`;
          break;
        }
      }
    }

    // Update server.properties level-name and restart
    const rawProps = await ptero.readFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties"
    );
    const updated = updateServerProperties(rawProps, { "level-name": resolvedLevelName });
    await ptero.writeFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties",
      updated.content
    );
    await ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "restart");

    return resolvedLevelName;
  });

  const { sealms } = await getCollections();
  if (minigame) {
    await sealms.updateOne(
      { numericId: sealm.numericId },
      { $set: { minigameActive: true, minigameName: worldName || "Minigame" } }
    );
  } else {
    await sealms.updateOne(
      { numericId: sealm.numericId },
      {
        $set: {
          activeSlot: targetSlot as 1 | 2 | 3,
          minigameActive: false,
          [`slots.${targetSlot}.levelName`]: finalLevelName,
          ...(worldName ? { [`slots.${targetSlot}.name`]: worldName } : {}),
        },
      }
    );
  }

  return c.json({ ok: true, levelName: finalLevelName });
});

// POST /sealms/:id/invites/code — Owner generates TTL-expiring invite code
sealmsRoutes.post("/sealms/:id/invites/code", rateLimitByUser("invite-code", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm || !sealm._id) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = createInviteCodeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid invite code options" }, 400);
  }

  const { config, getCollections } = c.get("deps");
  const { invites } = await getCollections();

  const activeCount = await invites.countDocuments({
    sealmNumericId: sealm.numericId,
    expiresAt: { $gt: new Date() },
  });
  if (activeCount >= config.maxActiveInviteCodesPerSealm) {
    return c.json(
      { error: `Maximum of ${config.maxActiveInviteCodesPerSealm} active invite codes per Sealm` },
      400
    );
  }

  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + parsed.data.expiresInHours * 3600_000);
  await invites.insertOne({
    code,
    sealmId: sealm._id,
    sealmNumericId: sealm.numericId,
    createdBy: user.uuid,
    maxUses: parsed.data.maxUses,
    uses: 0,
    expiresAt,
    createdAt: new Date(),
  });

  return c.json(
    {
      code,
      url: `${config.publicBaseUrl}/invite/${code}`,
      maxUses: parsed.data.maxUses,
      expiresAt: expiresAt.toISOString(),
    },
    201
  );
});

// GET /sealms/:id/invites/codes — Owner lists active invite codes
sealmsRoutes.get("/sealms/:id/invites/codes", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { config, getCollections } = c.get("deps");
  const { invites } = await getCollections();
  const docs = await invites
    .find({ sealmNumericId: sealm.numericId, expiresAt: { $gt: new Date() } })
    .toArray();

  return c.json({
    codes: docs.map((d) => ({
      code: d.code,
      url: `${config.publicBaseUrl}/invite/${d.code}`,
      maxUses: d.maxUses,
      uses: d.uses,
      expiresAt: d.expiresAt.toISOString(),
    })),
  });
});

// DELETE /sealms/:id/invites/code/:code — Owner revokes invite code
sealmsRoutes.delete("/sealms/:id/invites/code/:code", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const code = c.req.param("code").toUpperCase();
  const { getCollections } = c.get("deps");
  const { invites } = await getCollections();
  await invites.deleteOne({ sealmNumericId: sealm.numericId, code });

  return c.body(null, 204);
});

// POST /sealms/invites/redeem — Redeem SLM-XXXXX code or full URL
sealmsRoutes.post("/sealms/invites/redeem", rateLimitByIp("invite-redeem", 15, 60), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null);
  const parsed = redeemInviteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid invite code" }, 400);
  }

  const code = extractInviteCode(parsed.data.code);
  const { getCollections, ptero } = c.get("deps");
  const { invites, sealms } = await getCollections();

  const invite = await invites.findOne({
    code,
    expiresAt: { $gt: new Date() },
  });
  if (!invite) {
    return c.json({ error: "Invite code not found or expired" }, 404);
  }

  if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
    return c.json({ error: "Invite code has reached its maximum uses" }, 410);
  }

  const sealm = await sealms.findOne({ numericId: invite.sealmNumericId });
  if (!sealm) {
    return c.json({ error: "Sealm no longer exists" }, 404);
  }

  if (sealm.ownerUuid.toLowerCase() === user.uuid.toLowerCase()) {
    return c.json({ sealm: mapSealmToRealmsServer(sealm, user.uuid), alreadyMember: true });
  }

  const existingMember = sealm.members.find(
    (m) => m.uuid.toLowerCase() === user.uuid.toLowerCase()
  );
  if (existingMember?.accepted) {
    return c.json({ sealm: mapSealmToRealmsServer(sealm, user.uuid), alreadyMember: true });
  }

  if (existingMember) {
    await sealms.updateOne(
      { numericId: sealm.numericId, "members.uuid": existingMember.uuid },
      { $set: { "members.$.accepted": true, "members.$.name": user.username } }
    );
    existingMember.accepted = true;
    existingMember.name = user.username;
  } else {
    const newMember: SealmMember = {
      uuid: user.uuid,
      name: user.username,
      operator: false,
      accepted: true,
      invitedAt: new Date(),
    };
    await sealms.updateOne(
      { numericId: sealm.numericId },
      { $push: { members: newMember } }
    );
    sealm.members.push(newMember);
  }

  await invites.updateOne({ code }, { $inc: { uses: 1 } });

  if (isValidMinecraftUsername(user.username)) {
    try {
      await withPteroKey(c, sealm, (apiKey) =>
        ptero.sendCommand(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `whitelist add ${user.username}`
        )
      );
    } catch {
      // Server may be offline
    }
  }

  return c.json({
    sealm: mapSealmToRealmsServer(sealm, user.uuid),
    joined: true,
  });
});
