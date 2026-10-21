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

/**
 * `TRUSTED_IP_HEADER`: the name of a header your reverse proxy sets directly with the real client
 * IP (not a forwarded chain to walk) - e.g. Fly.io's `Fly-Client-IP`, Cloudflare's
 * `CF-Connecting-IP`, Vercel's `x-vercel-forwarded-for`, Netlify's `x-nf-client-connection-ip`.
 * Use this instead of (or alongside) TRUSTED_PROXIES when your platform's edge IPs aren't a
 * pinnable CIDR range - better-auth then reads this header instead of X-Forwarded-For.
 */
export const trustedIpHeaderSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, "Must look like an HTTP header name (letters, digits, hyphens).")
  .optional();

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
    // Redis: either REDIS_URL, or every discrete field below - never both, never a mix
    REDIS_PROVIDER: z.string().optional(),
    REDIS_USER: z.string().optional().default("default"),
    REDIS_PASSWORD: z.string().min(12).optional(),
    REDIS_HOST: z.string().optional().default("localhost"),
    REDIS_PORT: z.coerce.number().optional(),
    REDIS_DB: z.coerce.number().int().min(0).optional().default(0),
    REDIS_URL: z.url().optional(),
    // Rate limiting behind a proxy
    TRUSTED_PROXIES: trustedProxiesSchema,
    TRUSTED_IP_HEADER: trustedIpHeaderSchema,
    // Logging
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

/**
 * Enforces "either `<LABEL>_URL`, or every one of these discrete fields - never both, never a
 * mix" for a connection that supports both shapes (DB, Redis). Fields with their own default
 * (e.g. `DB_HOST`, `REDIS_HOST`) are never passed in here, since they're never actually
 * "missing" - only fields a discrete setup must genuinely supply belong in `discrete`.
 */
function requireUrlXorDiscrete(
  label: string,
  url: string | undefined,
  discrete: Record<string, unknown>,
) {
  const discreteFields = Object.keys(discrete);
  const setFields = discreteFields.filter((key) => discrete[key] !== undefined);

  if (url && setFields.length > 0) {
    throw new Error(
      `Set either ${label}_URL or the discrete ${label}_* fields, not both (${label}_URL is set alongside ${setFields.join(", ")})`,
    );
  }
  if (!url && setFields.length < discreteFields.length) {
    const missing = discreteFields.filter((key) => !setFields.includes(key));
    throw new Error(
      `Set either ${label}_URL or all of ${discreteFields.join(", ")} (missing ${missing.join(", ")})`,
    );
  }
}

requireUrlXorDiscrete("DB", env.DB_URL, {
  DB_PROVIDER: env.DB_PROVIDER,
  DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD,
  DB_PORT: env.DB_PORT,
  DB_NAME: env.DB_NAME,
});

requireUrlXorDiscrete("REDIS", env.REDIS_URL, {
  REDIS_PROVIDER: env.REDIS_PROVIDER,
  REDIS_PASSWORD: env.REDIS_PASSWORD,
  REDIS_PORT: env.REDIS_PORT,
});

if (env.NODE_ENV === "production" && !env.TRUSTED_PROXIES && !env.TRUSTED_IP_HEADER) {
  throw new Error(
    "Set TRUSTED_PROXIES or TRUSTED_IP_HEADER in production: unset, rate limiting trusts a " +
      "single-value X-Forwarded-For header unconditionally (a client can spoof a new IP per " +
      "request to dodge sign-in rate limits) and falls back to one shared bucket on a multi-hop " +
      "header (one client's flood 429s everyone else). Set TRUSTED_PROXIES to your reverse " +
      "proxy's IP/CIDR, or TRUSTED_IP_HEADER to a header your proxy sets directly with the real " +
      "client IP (e.g. Fly-Client-IP, CF-Connecting-IP).",
  );
}
