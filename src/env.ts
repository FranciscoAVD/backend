import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production"]),
    SERVER_PORT: z.coerce.number(),
    // Auth
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    CLIENT_URL: z.url(),
    // Payments
    PAYMENTS_ENABLED: z.stringbool().default(false),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Database
    DB_PROVIDER: z.string(),
    DB_USER: z.string(),
    DB_PASSWORD: z.string().min(12),
    DB_HOST: z.string().optional().default("localhost"),
    DB_PORT: z.coerce.number(),
    DB_NAME: z.string(),
    // Prod
    DB_URL: z.url().optional(),
    // Redis
    REDIS_PORT: z.coerce.number(),
    REDIS_URL: z.url(),
    // Logging
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

if (
  env.PAYMENTS_ENABLED &&
  (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)
) {
  throw new Error(
    "PAYMENTS_ENABLED=true requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET",
  );
}
