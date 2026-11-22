import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimitByUser } from "../middleware/ratelimit.js";
import {
  parseServerProperties,
  realmsOptionsToPropertiesUpdates,
  updateServerProperties,
  type RealmsSlotOptionsInput,
} from "../lib/properties.js";
import { mapBackupsToRealms, mapSealmToRealmsServer } from "../lib/realmsMapper.js";
import { PteroAuthError } from "../lib/ptero.js";
import { findSealmByNumericId, getUserRole, withPteroKey } from "./helpers.js";

const updateWorldMetaSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(200).optional(),
});

export const worldsRoutes = new Hono<AppEnv>();

worldsRoutes.use("/worlds", requireAuth);
worldsRoutes.use("/worlds/*", requireAuth);

// GET /worlds — owned + accepted Sealms
worldsRoutes.get("/worlds", async (c) => {
  const user = c.get("user")!;
  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();

  const docs = await sealms
    .find({
      $or: [
        { ownerUuid: user.uuid },
        { members: { $elemMatch: { uuid: user.uuid, accepted: true } } },
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();

  return c.json({
    servers: docs.map((d) => mapSealmToRealmsServer(d, user.uuid)),
  });
});

// GET /worlds/liveplayerlist — client mod runs local SLP pings
worldsRoutes.get("/worlds/liveplayerlist", (c) => {
  return c.json({ lists: [] });
});

// GET /worlds/v1/:id/join/pc — Seamless 503 Auto-Start & SLP Readiness Check
worldsRoutes.get(
  "/worlds/v1/:id/join/pc",
  rateLimitByUser("join-pc", 30, 60),
  async (c) => {
    const user = c.get("user")!;
    const sealm = await findSealmByNumericId(c, c.req.param("id"));
    if (!sealm) {
      return c.json({ errorCode: 404, errorMsg: "Sealm not found" }, 404);
    }

    const role = getUserRole(sealm, user.uuid);
    if (role === "none") {
      return c.json({ errorCode: 403, errorMsg: "You do not have access to this Sealm" }, 403);
    }

    if (sealm.state !== "OPEN") {
      return c.json({ errorCode: 403, errorMsg: "This Sealm is closed" }, 403);
    }

    const { ptero, pingServer, getCollections } = c.get("deps");

    try {
      const resources = await withPteroKey(c, sealm, (apiKey) =>
        ptero.getResources(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId)
      );

      if (resources.isSuspended) {
        return c.json({ errorCode: 403, errorMsg: "Game server is suspended" }, 403);
      }

      const state = resources.currentState;
      if (state === "offline" || state === "stopping") {
        const canWake = sealm.allowMemberWake || role === "owner" || role === "operator";
        if (!canWake) {
          return c.json(
            { errorCode: 403, errorMsg: "Server is offline and member auto-start is disabled" },
            403
          );
        }
        if (state === "offline") {
          await withPteroKey(c, sealm, (apiKey) =>
            ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "start")
          );
        }
        c.header("Retry-After", "5");
        return c.json({ errorCode: 503, errorMsg: "Starting server..." }, 503);
      }

      if (state === "starting") {
        c.header("Retry-After", "5");
        return c.json({ errorCode: 503, errorMsg: "Server is starting..." }, 503);
      }

      // state === "running": resolve address & verify SLP readiness
      let address = sealm.ptero.address;
      if (!address) {
        const details = await withPteroKey(c, sealm, (apiKey) =>
          ptero.getServerDetails(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId)
        );
        address = details.primaryAllocation?.address;
        if (address) {
          const { sealms } = await getCollections();
          await sealms.updateOne(
            { numericId: sealm.numericId },
            { $set: { "ptero.address": address } }
          );
        }
      }

      if (!address) {
        return c.json({ errorCode: 500, errorMsg: "Server has no primary network allocation" }, 500);
      }

      const slp = await pingServer(address, 2500);
      if (!slp.online) {
        c.header("Retry-After", "3");
        return c.json({ errorCode: 503, errorMsg: "World is still loading..." }, 503);
      }

      return c.json({
        address,
        resourcePackUrl: null,
        resourcePackHash: null,
      });
    } catch (err) {
      if (err instanceof PteroAuthError) {
        return c.json(
          {
            errorCode: 502,
            errorMsg:
              role === "owner"
                ? "Pterodactyl API key revoked. Open Configure to Update Credentials."
                : "Server is temporarily unavailable.",
          },
          502
        );
      }
      throw err;
    }
  }
);

// GET /worlds/:id — Owner/OP details + live server.properties
worldsRoutes.get("/worlds/:id", rateLimitByUser("ptero-read", 30, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) {
    return c.json({ error: "Sealm not found" }, 404);
  }
  const role = getUserRole(sealm, user.uuid);
  if (role !== "owner" && role !== "operator") {
    return c.json({ error: "Owner or Operator permission required" }, 403);
  }

  const { ptero } = c.get("deps");
  let liveProperties: Record<string, string> | undefined;
  try {
    const raw = await withPteroKey(c, sealm, (apiKey) =>
      ptero.readFile(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "/server.properties")
    );
    liveProperties = parseServerProperties(raw).values;
  } catch (err) {
    if (err instanceof PteroAuthError) {
      sealm.ptero.credentialsInvalid = true;
    }
  }

  return c.json(mapSealmToRealmsServer(sealm, user.uuid, liveProperties));
});

// PUT /worlds/:id/open — Owner opens Sealm and starts container
worldsRoutes.put("/worlds/:id/open", rateLimitByUser("ptero-power", 1, 10), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();
  await sealms.updateOne({ numericId: sealm.numericId }, { $set: { state: "OPEN" } });

  try {
    await withPteroKey(c, sealm, (apiKey) =>
      ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "start")
    );
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json({ error: "Pterodactyl API key invalid — please Update Credentials" }, 502);
    }
    throw err;
  }

  return c.text("true", 200);
});

// PUT /worlds/:id/close — Owner closes Sealm and stops container
worldsRoutes.put("/worlds/:id/close", rateLimitByUser("ptero-power", 1, 10), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();
  await sealms.updateOne({ numericId: sealm.numericId }, { $set: { state: "CLOSED" } });

  try {
    await withPteroKey(c, sealm, (apiKey) =>
      ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "stop")
    );
  } catch (err) {
    if (err instanceof PteroAuthError) {
      return c.json({ error: "Pterodactyl API key invalid — please Update Credentials" }, 502);
    }
    throw err;
  }

  return c.text("true", 200);
});

// POST /worlds/:id — Owner updates name / description
worldsRoutes.post("/worlds/:id", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = updateWorldMetaSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid metadata" }, 400);
  }

  const update: Record<string, string> = {};
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.description !== undefined) update.description = parsed.data.description;

  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();
  if (Object.keys(update).length > 0) {
    await sealms.updateOne({ numericId: sealm.numericId }, { $set: update });
  }

  return c.body(null, 204);
});

async function handleSlotSwitch(
  c: Context<AppEnv>,
  sealmIdParam: string,
  slotParam: string
) {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, sealmIdParam);
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const slot = Number.parseInt(slotParam, 10);
  if (slot !== 1 && slot !== 2 && slot !== 3) {
    return c.json({ error: "Slot must be 1, 2, or 3" }, 400);
  }

  const targetSlot = sealm.slots[slot] ?? { levelName: slot === 1 ? "world" : `world_slot_${slot}` };
  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();

  await withPteroKey(c, sealm, async (apiKey) => {
    const rawProps = await ptero.readFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties"
    );
    const updated = updateServerProperties(rawProps, { "level-name": targetSlot.levelName });
    await ptero.writeFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties",
      updated.content
    );
    await ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "restart");
  });

  await sealms.updateOne(
    { numericId: sealm.numericId },
    {
      $set: {
        activeSlot: slot as 1 | 2 | 3,
        minigameActive: false,
        [`slots.${slot}`]: targetSlot,
      },
    }
  );

  return c.text("true", 200);
}

// PUT /worlds/:id/slot/:slot — Switch active world slot
worldsRoutes.put("/worlds/:id/slot/:slot", rateLimitByUser("ptero-write", 20, 60), async (c) => {
  return handleSlotSwitch(c, c.req.param("id"), c.req.param("slot"));
});

// POST /worlds/:id/slot/:slot — Update slot options OR switch slot if body is empty
worldsRoutes.post("/worlds/:id/slot/:slot", rateLimitByUser("ptero-write", 20, 60), async (c) => {
  const rawBody = await c.req.text();
  if (!rawBody || rawBody.trim() === "" || rawBody.trim() === "{}") {
    return handleSlotSwitch(c, c.req.param("id"), c.req.param("slot"));
  }

  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const slot = Number.parseInt(c.req.param("slot"), 10);
  if (slot !== 1 && slot !== 2 && slot !== 3) {
    return c.json({ error: "Slot must be 1, 2, or 3" }, 400);
  }

  let body: RealmsSlotOptionsInput;
  try {
    body = JSON.parse(rawBody) as RealmsSlotOptionsInput;
  } catch {
    return c.json({ error: "Invalid JSON options" }, 400);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();
  const existingSlot = sealm.slots[slot] ?? {
    levelName: slot === 1 ? "world" : `world_slot_${slot}`,
  };

  await sealms.updateOne(
    { numericId: sealm.numericId },
    {
      $set: {
        [`slots.${slot}`]: {
          levelName: existingSlot.levelName,
          name: body.slotName ?? existingSlot.name,
          options: {
            pvp: body.pvp,
            spawnAnimals: body.spawnAnimals,
            spawnMonsters: body.spawnMonsters,
            spawnNPCs: body.spawnNPCs,
            spawnProtection: body.spawnProtection,
            commandBlocks: body.commandBlocks,
            forceGameMode: body.forceGameMode,
            difficulty: body.difficulty,
            gameMode: body.gameMode,
          },
        },
      },
    }
  );

  // If editing the currently active slot, persist to server.properties & dispatch live commands
  if (slot === sealm.activeSlot) {
    const propUpdates = realmsOptionsToPropertiesUpdates(body);
    if (Object.keys(propUpdates).length > 0) {
      await withPteroKey(c, sealm, async (apiKey) => {
        const rawProps = await ptero.readFile(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          "/server.properties"
        );
        const result = updateServerProperties(rawProps, propUpdates);
        await ptero.writeFile(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          "/server.properties",
          result.content
        );

        const res = await ptero.getResources(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId
        );
        if (res.currentState === "running") {
          for (const cmd of result.liveCommands) {
            await ptero.sendCommand(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, cmd);
          }
          if (result.requiresRestart) {
            await ptero.sendPowerSignal(
              sealm.ptero.panelUrl,
              apiKey,
              sealm.ptero.serverId,
              "restart"
            );
          }
        }
      });
    }
  }

  return c.body(null, 204);
});

// PUT /worlds/:id/minigames/:minigameId — Switch to dedicated sealm_minigame folder without overwriting Slots 1-3
worldsRoutes.put("/worlds/:id/minigames/:minigameId", rateLimitByUser("ptero-write", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { getCollections, ptero } = c.get("deps");
  await withPteroKey(c, sealm, async (apiKey) => {
    const rawProps = await ptero.readFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties"
    );
    const updated = updateServerProperties(rawProps, { "level-name": "sealm_minigame" });
    await ptero.writeFile(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/server.properties",
      updated.content
    );
    await ptero.sendPowerSignal(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, "restart");
  });

  const { sealms } = await getCollections();
  await sealms.updateOne(
    { numericId: sealm.numericId },
    { $set: { minigameActive: true, minigameName: `Minigame ${c.req.param("minigameId")}` } }
  );

  return c.text("true", 200);
});

// GET /worlds/:id/backups — Proxy Pterodactyl backups list
worldsRoutes.get("/worlds/:id/backups", rateLimitByUser("ptero-read", 30, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { ptero } = c.get("deps");
  const backups = await withPteroKey(c, sealm, (apiKey) =>
    ptero.listBackups(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId)
  );

  return c.json(mapBackupsToRealms(backups));
});

// PUT /worlds/:id/backups?backupId=... — Restore Pterodactyl backup
worldsRoutes.put("/worlds/:id/backups", rateLimitByUser("ptero-power", 1, 10), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const backupId = c.req.query("backupId");
  if (!backupId) {
    return c.json({ error: "Missing backupId query parameter" }, 400);
  }

  const { ptero } = c.get("deps");
  await withPteroKey(c, sealm, (apiKey) =>
    ptero.restoreBackup(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId, backupId, true)
  );

  return c.body(null, 204);
});

// GET /worlds/:id/slot/:slot/download — Return signed Wings download URL for the slot's world
worldsRoutes.get("/worlds/:id/slot/:slot/download", rateLimitByUser("ptero-write", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const slot = Number.parseInt(c.req.param("slot"), 10);
  const slotCfg = sealm.slots[slot] ?? { levelName: slot === 1 ? "world" : `world_slot_${slot}` };
  const { ptero } = c.get("deps");

  const downloadLink = await withPteroKey(c, sealm, async (apiKey) => {
    const archive = await ptero.compressFiles(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      "/",
      [slotCfg.levelName]
    );
    return ptero.getSignedDownloadUrl(
      sealm.ptero.panelUrl,
      apiKey,
      sealm.ptero.serverId,
      `/${archive.name}`
    );
  });

  return c.json({
    downloadLink,
    resourcePackUrl: "",
    resourcePackHash: "",
  });
});

// PUT /worlds/:id/backups/upload — Return signed Wings upload URL for direct client upload
worldsRoutes.put("/worlds/:id/backups/upload", rateLimitByUser("ptero-write", 10, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const { ptero } = c.get("deps");
  const uploadEndpoint = await withPteroKey(c, sealm, (apiKey) =>
    ptero.getSignedUploadUrl(sealm.ptero.panelUrl, apiKey, sealm.ptero.serverId)
  );

  return c.json({
    worldClosed: true,
    token: "",
    uploadEndpoint,
  });
});
