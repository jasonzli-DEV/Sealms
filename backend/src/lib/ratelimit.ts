import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetMs: number;
}

export interface RateLimiter {
  limit(bucket: string, key: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult>;
}

export function createRateLimiter(redisUrl?: string, redisToken?: string): RateLimiter {
  if (redisUrl && redisToken) {
    const redis = new Redis({ url: redisUrl, token: redisToken });
    const limiters = new Map<string, Ratelimit>();

    return {
      async limit(bucket, key, maxRequests, windowSeconds) {
        const cacheKey = `${bucket}:${maxRequests}:${windowSeconds}`;
        let rl = limiters.get(cacheKey);
        if (!rl) {
          rl = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
            prefix: `sealms:rl:${bucket}`,
          });
          limiters.set(cacheKey, rl);
        }
        const res = await rl.limit(key);
        return {
          success: res.success,
          remaining: res.remaining,
          resetMs: Math.max(0, res.reset - Date.now()),
        };
      },
    };
  }

  // In-memory sliding window fallback for local dev & tests
  const windows = new Map<string, number[]>();

  return {
    async limit(bucket, key, maxRequests, windowSeconds) {
      const now = Date.now();
      const windowMs = windowSeconds * 1000;
      const fullKey = `${bucket}:${key}`;
      const timestamps = (windows.get(fullKey) ?? []).filter((t) => now - t < windowMs);
      if (timestamps.length >= maxRequests) {
        const oldest = timestamps[0];
        windows.set(fullKey, timestamps);
        return {
          success: false,
          remaining: 0,
          resetMs: Math.max(0, oldest + windowMs - now),
        };
      }
      timestamps.push(now);
      windows.set(fullKey, timestamps);
      return {
        success: true,
        remaining: Math.max(0, maxRequests - timestamps.length),
        resetMs: windowMs,
      };
    },
  };
}
