import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimitByUser } from "../middleware/ratelimit.js";
import { isValidMinecraftUsername, stripUuid } from "../lib/mojang.js";
import { findSealmByNumericId, getUserRole, withPteroKey } from "./helpers.js";

export const opsRoutes = new Hono<AppEnv>();

opsRoutes.use("/ops/*", requireAuth);

// POST /ops/:id/:uuid — Promote member to Operator + run `op`
opsRoutes.post("/ops/:id/:uuid", rateLimitByUser("ptero-write", 20, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const targetClean = stripUuid(c.req.param("uuid"));
  const member = sealm.members.find((m) => stripUuid(m.uuid) === targetClean);
  if (!member) {
    return c.json({ error: "Player is not a member of this Sealm" }, 404);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();

  await sealms.updateOne(
    { numericId: sealm.numericId, "members.uuid": member.uuid },
    { $set: { "members.$.operator": true } }
  );
  member.operator = true;

  if (isValidMinecraftUsername(member.name)) {
    try {
      await withPteroKey(c, sealm, (apiKey) =>
        ptero.sendCommand(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `op ${member.name}`
        )
      );
    } catch {
      // Server may be offline
    }
  }

  return c.json({
    ops: sealm.members.filter((m) => m.operator).map((m) => m.name),
  });
});

// DELETE /ops/:id/:uuid — Demote Operator + run `deop`
opsRoutes.delete("/ops/:id/:uuid", rateLimitByUser("ptero-write", 20, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const targetClean = stripUuid(c.req.param("uuid"));
  const member = sealm.members.find((m) => stripUuid(m.uuid) === targetClean);
  if (!member) {
    return c.json({ error: "Player is not a member of this Sealm" }, 404);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();

  await sealms.updateOne(
    { numericId: sealm.numericId, "members.uuid": member.uuid },
    { $set: { "members.$.operator": false } }
  );
  member.operator = false;

  if (isValidMinecraftUsername(member.name)) {
    try {
      await withPteroKey(c, sealm, (apiKey) =>
        ptero.sendCommand(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `deop ${member.name}`
        )
      );
    } catch {
      // Server may be offline
    }
  }

  return c.json({
    ops: sealm.members.filter((m) => m.operator).map((m) => m.name),
  });
});
