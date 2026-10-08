import { RedisClient } from "bun";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";

const RECONNECT_INTERVAL_MS = 5_000;

// no offline queue: while disconnected, commands reject right away instead of
// waiting out the retries, so callers can fail soft without stalling the request
export const redis = new RedisClient(env.REDIS_URL, {
  connectionTimeout: 2_000,
  maxRetries: 3,
  enableOfflineQueue: false,
});

let reconnecting = false;

/**
 * @description Bun stops reconnecting once `maxRetries` is spent and never retries on
 * its own after that, so keep calling `connect()` until Redis is back.
 */
function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(async () => {
    const [, error] = await tryCatch(redis.connect());
    reconnecting = false;
    if (error) scheduleReconnect();
    else logger.info({}, "redis.reconnect");
  }, RECONNECT_INTERVAL_MS).unref();
}

redis.onclose = (error) => {
  // failed reconnect attempts close again; only log the first close of an outage
  if (!reconnecting) logger.error({ err: error }, "redis.close");
  scheduleReconnect();
};

// awaited so importers only run once connected: without the offline queue, a
// command sent before the first connection completes would be rejected
const [, connectError] = await tryCatch(redis.connect());
if (connectError) {
  logger.error({ err: connectError }, "redis.connect");
  scheduleReconnect();
}

// one script so the counter can't exist without an expiry; the TTL check also
// repairs keys left without one
const INCREMENT_WITH_TTL = `
local count = redis.call("INCR", KEYS[1])
if redis.call("TTL", KEYS[1]) == -1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count
`;

/** @description Atomically increments `key`, giving it a `ttlSec` expiry if it has none. */
export async function incrementWithTTL(
  key: string,
  ttlSec: number,
): Promise<number> {
  return redis.send("EVAL", [INCREMENT_WITH_TTL, "1", key, String(ttlSec)]);
}
