import { incrementWithTTL, redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";
/**
 * @description better-auth's `secondaryStorage` contract (get/set/delete/getAndDelete
 * for session + verification caching, increment for rate limiting). better-auth calls
 * all of these once `secondaryStorage` is configured, not just the ones a given
 * feature needs, so every method must be implemented even though this is only being
 * wired up for rate limiting.
 *
 * Redis errors are logged and swallowed instead of thrown: better-auth doesn't catch
 * them, so a Redis outage would otherwise fail every auth request. Keys are never
 * logged since session keys are the raw session tokens.
 */
export const authSecondaryStorage = {
  // a miss makes better-auth fall back to the session row in the DB
  get: async (key: string) => {
    const [value, error] = await tryCatch(redis.get(key));
    if (error) logger.error({ err: error }, "auth.storage.get");
    return value;
  },
  set: async (key: string, value: string, ttl?: number) => {
    const [, error] = await tryCatch(
      ttl ? redis.set(key, value, "EX", ttl) : redis.set(key, value),
    );
    if (error) logger.error({ err: error }, "auth.storage.set");
  },
  delete: async (key: string) => {
    const [, error] = await tryCatch(redis.del(key));
    if (error) logger.error({ err: error }, "auth.storage.delete");
  },
  // a miss fails the verification, so the caller must restart the flow
  getAndDelete: async (key: string) => {
    const [value, error] = await tryCatch(redis.getdel(key));
    if (error) logger.error({ err: error }, "auth.storage.getAndDelete");
    return value;
  },
  // fails open: 0 is under every limit, so rate limiting is off while Redis is down
  increment: async (key: string, ttl?: number) => {
    const [count, error] = await tryCatch(
      ttl ? incrementWithTTL(key, ttl) : redis.incr(key),
    );
    if (error) logger.error({ err: error }, "auth.storage.increment");
    return count ?? 0;
  },
};
