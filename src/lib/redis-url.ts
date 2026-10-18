import { env } from "@/env";

// env.ts guarantees every discrete field is set whenever REDIS_URL isn't
export const REDIS_URL =
  env.REDIS_URL ??
  (`${env.REDIS_PROVIDER}://${env.REDIS_USER}:${encodeURIComponent(env.REDIS_PASSWORD!)}@${env.REDIS_HOST}:${env.REDIS_PORT}/${env.REDIS_DB}` as const);
