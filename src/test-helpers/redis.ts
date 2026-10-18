import { redis } from "@/lib/redis";

/**
 * @description Empties the test Redis database for isolation between tests. Only
 * safe because `bun run test` points REDIS_DB at index 1, never dev's (index 0) —
 * see package.json's `test` script. Never call this outside of `bun run test`.
 */
export async function resetRedis(): Promise<void> {
  await redis.send("FLUSHDB", []);
}
