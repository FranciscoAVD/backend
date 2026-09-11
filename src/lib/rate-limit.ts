import { createMiddleware } from "hono/factory";
import { redis } from "@/lib/redis";
import type { RequireSessionEnv } from "@f/auth/middleware/require";

type RateLimitOptions = {
  /** Window size in seconds. */
  windowSec: number;
  /** Max requests allowed per window. */
  max: number;
  /** Namespaces the counter so different routes don't share a budget. */
  keyPrefix: string;
};

export function rateLimiter({ windowSec, max, keyPrefix }: RateLimitOptions) {
  return createMiddleware<RequireSessionEnv>(async (c, next) => {
    const { user } = c.get("session");
    const key = `ratelimit:${keyPrefix}:${user.id}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }

    if (count > max) {
      const retryAfter = await redis.ttl(key);
      return c.json(
        { message: "Too many requests. Please try again later." },
        429,
        { "Retry-After": String(Math.max(retryAfter, 1)) },
      );
    }

    await next();
  });
}
