import { env } from "@/env";

export const DB_URL =
  env.DB_URL ??
  (`${env.DB_PROVIDER}://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}` as const);
