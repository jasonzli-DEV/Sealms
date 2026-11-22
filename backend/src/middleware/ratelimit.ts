import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.js";

export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return headers.get("x-real-ip") || "127.0.0.1";
}

export function rateLimitByIp(
  bucket: string,
  maxRequests: number,
  windowSeconds: number
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { rateLimiter } = c.get("deps");
    const ip = getClientIp(c.req.raw.headers);
    const result = await rateLimiter.limit(bucket, ip, maxRequests, windowSeconds);
    if (!result.success) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(result.resetMs / 1000))));
      return c.json({ error: "Too many requests. Please slow down." }, 429);
    }
    await next();
  };
}

export function rateLimitByUser(
  bucket: string,
  maxRequests: number,
  windowSeconds: number
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { rateLimiter } = c.get("deps");
    const user = c.get("user");
    const key = user?.uuid ?? getClientIp(c.req.raw.headers);
    const result = await rateLimiter.limit(bucket, key, maxRequests, windowSeconds);
    if (!result.success) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(result.resetMs / 1000))));
      return c.json({ error: "Rate limit exceeded." }, 429);
    }
    await next();
  };
}
