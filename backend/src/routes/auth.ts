import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { generateNonce } from "../lib/crypto.js";
import { signSealmsJwt } from "../lib/jwt.js";
import { isValidMinecraftUsername } from "../lib/mojang.js";
import { rateLimitByIp } from "../middleware/ratelimit.js";

const verifySchema = z.object({
  username: z.string().min(3).max(16),
  serverId: z.string().min(16).max(64),
});

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/sealms/auth/challenge", rateLimitByIp("auth-challenge", 20, 60), async (c) => {
  const { getCollections } = c.get("deps");
  const { authNonces } = await getCollections();

  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + 60_000);
  await authNonces.insertOne({ nonce, expiresAt });

  return c.json({
    serverId: nonce,
    expiresAt: expiresAt.toISOString(),
  });
});

authRoutes.post("/sealms/auth/verify", rateLimitByIp("auth-verify", 20, 60), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request payload" }, 400);
  }

  const { username, serverId } = parsed.data;
  if (!isValidMinecraftUsername(username)) {
    return c.json({ error: "Invalid Minecraft username" }, 400);
  }

  const { getCollections, mojang, config } = c.get("deps");
  const { authNonces } = await getCollections();

  // Atomically consume nonce so it cannot be replayed
  const consumed = await authNonces.findOneAndDelete({
    nonce: serverId,
    expiresAt: { $gt: new Date() },
  });
  if (!consumed) {
    return c.json({ error: "Invalid or expired authentication challenge" }, 401);
  }

  const profile = await mojang.verifyHasJoined(username, serverId);
  if (!profile) {
    return c.json({ error: "Mojang session verification failed" }, 401);
  }

  const token = await signSealmsJwt(
    { uuid: profile.uuid, username: profile.username },
    config.jwtSecret
  );

  return c.json({
    token,
    uuid: profile.uuid,
    username: profile.username,
  });
});
