import { createRateLimit } from "@vicstack/rate-limit";
import { incrementWithTTL, redis } from "@backend/lib/redis";
import { logger } from "@backend/lib/logger";

export const rateLimiter = createRateLimit({
  redis: { client: redis, increment: incrementWithTTL },
  onError: (error, context) => logger.error({ err: error }, context),
});
