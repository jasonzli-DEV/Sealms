import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimitByUser } from "../middleware/ratelimit.js";
import { isValidMinecraftUsername, stripUuid } from "../lib/mojang.js";
import { mapSealmToRealmsServer } from "../lib/realmsMapper.js";
import { findSealmByNumericId, getUserRole, withPteroKey } from "./helpers.js";

const invitePlayerSchema = z.object({
  name: z.string().min(3).max(16),
});

export const invitesRoutes = new Hono<AppEnv>();

invitesRoutes.use("/invites", requireAuth);
invitesRoutes.use("/invites/*", requireAuth);

// GET /invites/pending — Pending invites (accepted: false) for current player
invitesRoutes.get("/invites/pending", async (c) => {
  const user = c.get("user")!;
  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();

  const docs = await sealms
    .find({
      members: { $elemMatch: { uuid: user.uuid, accepted: false } },
    })
    .toArray();

  const invites = docs.map((doc) => {
    const member = doc.members.find(
      (m) => m.uuid.toLowerCase() === user.uuid.toLowerCase() && !m.accepted
    );
    return {
      invitationId: String(doc.numericId),
      worldName: doc.name,
      worldDescription: doc.description,
      worldOwnerName: doc.ownerName,
      worldOwnerUuid: stripUuid(doc.ownerUuid),
      date: member?.invitedAt ? new Date(member.invitedAt).getTime() : Date.now(),
    };
  });

  return c.json({ invites });
});

// GET /invites/count/pending — Vanilla Realms polls this for the envelope badge
invitesRoutes.get("/invites/count/pending", async (c) => {
  const user = c.get("user")!;
  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();

  const count = await sealms.countDocuments({
    members: { $elemMatch: { uuid: user.uuid, accepted: false } },
  });

  return c.text(String(count), 200);
});

// POST /invites/:id — Owner invites player by username
invitesRoutes.post("/invites/:id", rateLimitByUser("invite-player", 20, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = invitePlayerSchema.safeParse(body);
  if (!parsed.success || !isValidMinecraftUsername(parsed.data.name)) {
    return c.json({ error: "Invalid Minecraft username" }, 400);
  }

  const { mojang, getCollections, ptero, config } = c.get("deps");
  const profile = await mojang.lookupProfileByUsername(parsed.data.name);
  if (!profile) {
    return c.json({ error: "Minecraft player not found" }, 404);
  }

  if (profile.uuid.toLowerCase() === sealm.ownerUuid.toLowerCase()) {
    return c.json({ error: "You are already the owner of this Sealm" }, 400);
  }

  const { sealms, blockedOwners } = await getCollections();

  // Check if target player has blocked this owner
  const blocked = await blockedOwners.findOne({
    playerUuid: profile.uuid,
    blockedOwnerUuid: sealm.ownerUuid,
  });
  if (blocked) {
    return c.json({ error: "This player is not accepting invites from you" }, 403);
  }

  // Anti-spam: cap pending invites sent in the last 24h
  const oneDayAgo = new Date(Date.now() - 86_400_000);
  const recentPending = sealm.members.filter(
    (m) => !m.accepted && new Date(m.invitedAt) > oneDayAgo
  ).length;
  if (recentPending >= config.maxDailyPendingInvites) {
    return c.json({ error: "Daily pending invite limit reached" }, 429);
  }

  const alreadyMember = sealm.members.some(
    (m) => m.uuid.toLowerCase() === profile.uuid.toLowerCase()
  );
  if (!alreadyMember) {
    const newMember = {
      uuid: profile.uuid,
      name: profile.username,
      operator: false,
      accepted: false,
      invitedAt: new Date(),
    };
    await sealms.updateOne(
      { numericId: sealm.numericId },
      { $push: { members: newMember } }
    );
    sealm.members.push(newMember);
  }

  // Dispatch safe whitelist add (username verified against Mojang + regex)
  try {
    await withPteroKey(c, sealm, (apiKey) =>
      ptero.sendCommand(
        sealm.ptero.panelUrl,
        apiKey,
        sealm.ptero.serverId,
        `whitelist add ${profile.username}`
      )
    );
  } catch {
    // Non-fatal if server is currently offline; whitelist will sync or apply when running
  }

  return c.json(mapSealmToRealmsServer(sealm, user.uuid));
});

// DELETE /invites/:id/invite/:uuid — Owner removes member + whitelist remove
invitesRoutes.delete("/invites/:id/invite/:uuid", rateLimitByUser("ptero-write", 20, 60), async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Sealm not found" }, 404);
  if (getUserRole(sealm, user.uuid) !== "owner") {
    return c.json({ error: "Owner permission required" }, 403);
  }

  const targetUuidClean = stripUuid(c.req.param("uuid"));
  const member = sealm.members.find((m) => stripUuid(m.uuid) === targetUuidClean);
  if (!member) {
    return c.body(null, 204);
  }

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();

  await sealms.updateOne(
    { numericId: sealm.numericId },
    { $pull: { members: { uuid: member.uuid } } }
  );

  if (isValidMinecraftUsername(member.name)) {
    try {
      await withPteroKey(c, sealm, (apiKey) =>
        ptero.sendCommand(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `whitelist remove ${member.name}`
        )
      );
    } catch {
      // Server may be offline
    }
  }

  return c.body(null, 204);
});

// DELETE /invites/:id — Player leaves a Sealm (uninvite myself)
invitesRoutes.delete("/invites/:id", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.body(null, 204);

  const { getCollections, ptero } = c.get("deps");
  const { sealms } = await getCollections();
  await sealms.updateOne(
    { numericId: sealm.numericId },
    { $pull: { members: { uuid: user.uuid } } }
  );

  if (isValidMinecraftUsername(user.username)) {
    try {
      await withPteroKey(c, sealm, (apiKey) =>
        ptero.sendCommand(
          sealm.ptero.panelUrl,
          apiKey,
          sealm.ptero.serverId,
          `whitelist remove ${user.username}`
        )
      );
    } catch {
      // Server may be offline
    }
  }
  return c.body(null, 204);
});

// PUT /invites/accept/:id — Player accepts pending invite
invitesRoutes.put("/invites/accept/:id", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Invitation not found" }, 404);

  const { getCollections } = c.get("deps");
  const { sealms } = await getCollections();

  const res = await sealms.updateOne(
    {
      numericId: sealm.numericId,
      members: { $elemMatch: { uuid: user.uuid, accepted: false } },
    },
    { $set: { "members.$.accepted": true, "members.$.name": user.username } }
  );

  if (res.matchedCount === 0) {
    return c.json({ error: "Pending invitation not found" }, 404);
  }

  return c.body(null, 204);
});

// PUT /invites/reject/:id — Player rejects pending invite (supports ?blockOwner=true)
invitesRoutes.put("/invites/reject/:id", async (c) => {
  const user = c.get("user")!;
  const sealm = await findSealmByNumericId(c, c.req.param("id"));
  if (!sealm) return c.json({ error: "Invitation not found" }, 404);

  const blockOwner = c.req.query("blockOwner") === "true";
  const { getCollections } = c.get("deps");
  const { sealms, blockedOwners } = await getCollections();

  await sealms.updateOne(
    { numericId: sealm.numericId },
    { $pull: { members: { uuid: user.uuid, accepted: false } } }
  );

  if (blockOwner) {
    await blockedOwners.updateOne(
      { playerUuid: user.uuid, blockedOwnerUuid: sealm.ownerUuid },
      {
        $setOnInsert: {
          playerUuid: user.uuid,
          blockedOwnerUuid: sealm.ownerUuid,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  return c.body(null, 204);
});
