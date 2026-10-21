import { redis } from "@backend/lib/redis";
import { assertTestRedisDb, parseClientInfoDb } from "@backend/test-helpers/guard";

// checked once per process: the connection's selected database can't change under it
let verified: Promise<void> | undefined;
const verifyTestRedisDb = () =>
  (verified ??= (async () => {
    const info = await redis.send("CLIENT", ["INFO"]);
    assertTestRedisDb(parseClientInfoDb(String(info)));
  })());

/**
 * @description Empties the test Redis database for isolation between tests. Refuses (throws)
 * unless the connection's selected database is index 1, `bun run test`'s `REDIS_DB=1` - see
 * `test-helpers/guard.ts` for why that's checked on the live connection.
 */
export async function resetRedis(): Promise<void> {
  await verifyTestRedisDb();
  await redis.send("FLUSHDB", []);
}
