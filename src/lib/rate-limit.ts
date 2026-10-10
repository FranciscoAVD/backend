import { createMiddleware } from "hono/factory";
import { incrementWithTTL, redis } from "@/lib/redis";
import type { RequireSessionEnv } from "@f/auth/middleware";
import HTTP from "@vicstack/http";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

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

    // fails open: a Redis outage shouldn't take the write routes down with it
    const [count, error] = await tryCatch(incrementWithTTL(key, windowSec));
    if (error) {
      logger.error({ err: error, user: user.id }, `ratelimit.${keyPrefix}`);
      return next();
    }

    if (count > max) {
      const [ttl] = await tryCatch(redis.ttl(key));
      const retryAfter = ttl ?? windowSec;
      return c.json(
        { message: "Too many requests. Please try again later." },
        HTTP.TooManyRequests,
        { "Retry-After": String(Math.max(retryAfter, 1)) },
      );
    }

    await next();
  });
}
