import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.js";
import { verifySealmsJwt } from "../lib/jwt.js";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "Missing Authorization Bearer token" }, 401);
  }

  const { config } = c.get("deps");
  try {
    const user = await verifySealmsJwt(match[1].trim(), config.jwtSecret);
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired Sealms token" }, 401);
  }
};
