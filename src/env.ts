import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * `TRUSTED_PROXIES`: comma-separated IPs/CIDRs of this app's own reverse proxies, so better-auth can
 * find the real client IP in a multi-hop `X-Forwarded-For` and rate-limit each client separately.
 * Unset, a request that came through more than one hop has no trustworthy client IP, and every such
 * request shares one rate-limit bucket - one client's flood throttles everyone. Validated here
 * rather than left to better-auth, which silently drops an entry it can't parse.
 */
export const trustedProxiesSchema = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(",").map((entry) => entry.trim()) : undefined))
  .pipe(z.array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])).min(1).optional());

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]),
    SERVER_PORT: z.coerce.number(),
    // Auth
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    CLIENT_URL: z.url(),
    // Payments
    STRIPE_SECRET_KEY: z.string(),
    STRIPE_WEBHOOK_SECRET: z.string(),
    // Email
    RESEND_API_KEY: z.string(),
    EMAIL_FROM: z.string(),
    // Database: either DB_URL, or every discrete field below - never both, never a mix
    DB_PROVIDER: z.string().optional(),
    DB_USER: z.string().optional(),
    DB_PASSWORD: z.string().min(12).optional(),
    DB_HOST: z.string().optional().default("localhost"),
    DB_PORT: z.coerce.number().optional(),
    DB_NAME: z.string().optional(),
    DB_URL: z.url().optional(),
    // Redis
    REDIS_PORT: z.coerce.number(),
    REDIS_URL: z.url(),
    // Rate limiting behind a proxy
    TRUSTED_PROXIES: trustedProxiesSchema,
    // Logging
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

const DISCRETE_DB_FIELDS = [
  "DB_PROVIDER",
  "DB_USER",
  "DB_PASSWORD",
  "DB_PORT",
  "DB_NAME",
] as const;

const setDiscreteDbFields = DISCRETE_DB_FIELDS.filter(
  (key) => env[key] !== undefined,
);

if (env.DB_URL && setDiscreteDbFields.length > 0) {
  throw new Error(
    `Set either DB_URL or the discrete DB_* fields, not both (DB_URL is set alongside ${setDiscreteDbFields.join(", ")})`,
  );
}
if (!env.DB_URL && setDiscreteDbFields.length < DISCRETE_DB_FIELDS.length) {
  const missing = DISCRETE_DB_FIELDS.filter(
    (key) => !setDiscreteDbFields.includes(key),
  );
  throw new Error(
    `Set either DB_URL or all of ${DISCRETE_DB_FIELDS.join(", ")} (missing ${missing.join(", ")})`,
  );
}
