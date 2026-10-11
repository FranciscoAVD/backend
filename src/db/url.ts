import { env } from "@/env";

// env.ts guarantees every discrete field is set whenever DB_URL isn't
export const DB_URL =
  env.DB_URL ??
  (`${env.DB_PROVIDER}://${env.DB_USER}:${encodeURIComponent(env.DB_PASSWORD!)}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}` as const);
