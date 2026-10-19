/**
 * Refuses to let a test helper wipe anything but a test database. `bun run test` isolates itself
 * with `DB_NAME=backend_test REDIS_DB=1`, but those only reach the connection when `.env` uses the
 * discrete DB_* / REDIS_* fields - with DB_URL / REDIS_URL set, the URL is used as-is and both are
 * silently ignored, so `resetDb()`/`resetRedis()` would truncate and flush whatever the URLs point
 * at (the dev database, or worse). So the check is on what the connection actually reached, not on
 * the env vars meant to steer it.
 */

/** The Redis logical database the test suite owns - `bun run test`'s `REDIS_DB=1`. */
export const TEST_REDIS_DB = 1;

/** @throws unless the connected Postgres database is a test one (name ending in `_test`). */
export function assertTestDatabaseName(name: string): void {
  if (!name.endsWith("_test"))
    throw new Error(
      `Refusing to reset Postgres database "${name}": test helpers only wipe a database whose ` +
        `name ends in "_test". Run \`bun run test\` (not bare \`bun test\`) with the discrete ` +
        `DB_* fields in .env - DB_NAME=backend_test can't override a DB_URL.`,
    );
}

/**
 * @description The selected database index from a Redis `CLIENT INFO` reply (`... db=1 ...`).
 * @returns the index, or null if the reply has none.
 */
export function parseClientInfoDb(info: string): number | null {
  const match = /(?:^|\s)db=(\d+)(?:\s|$)/.exec(info);
  return match ? Number(match[1]) : null;
}

/** @throws unless the connection's selected Redis database is `TEST_REDIS_DB`. */
export function assertTestRedisDb(db: number | null): void {
  if (db !== TEST_REDIS_DB)
    throw new Error(
      `Refusing to flush Redis database ${db ?? "(unknown)"}: test helpers only flush db ` +
        `${TEST_REDIS_DB}. Run \`bun run test\` (not bare \`bun test\`) with the discrete REDIS_* ` +
        `fields in .env - REDIS_DB=1 can't override a REDIS_URL.`,
    );
}
