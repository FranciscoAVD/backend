import { createRedis } from "@vicstack/redis";
import { REDIS_URL } from "@/lib/redis-url";
import { logger } from "@/lib/logger";

const { client, ready, increment } = createRedis({
  url: REDIS_URL,
  onError: (error, context) => logger.error({ err: error }, context),
});

// awaited so importers only run once connected: without the offline queue, a
// command sent before the first connection completes would be rejected
await ready;

export const redis = client;
export const incrementWithTTL = increment;
