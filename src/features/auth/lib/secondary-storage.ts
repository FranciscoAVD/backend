import { redis } from "@/lib/redis";
/**
 * @description better-auth's `secondaryStorage` contract (get/set/delete/getAndDelete
 * for session + verification caching, increment for rate limiting). better-auth calls
 * all of these once `secondaryStorage` is configured, not just the ones a given
 * feature needs, so every method must be implemented even though this is only being
 * wired up for rate limiting.
 */
export const authSecondaryStorage = {
  get: (key: string) => redis.get(key),
  set: async (key: string, value: string, ttl?: number) => {
    if (ttl) await redis.set(key, value, "EX", ttl);
    else await redis.set(key, value);
  },
  delete: async (key: string) => {
    await redis.del(key);
  },
  getAndDelete: (key: string) => redis.getdel(key),
  increment: async (key: string, ttl?: number) => {
    const count = await redis.incr(key);
    if (count === 1 && ttl) await redis.expire(key, ttl);
    return count;
  },
};
