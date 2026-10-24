import type { Context } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import HTTP from "@vicstack/http";

export const ok = <E extends PinoLoggerEnv, T, U extends ContentfulStatusCode>(
  c: Context<E>,
  data: T,
  message: string,
  status: U,
) => c.json({ data, message }, status);

export const serverError = <E extends PinoLoggerEnv>(
  c: Context<E>,
  error: unknown,
  scope: string,
  meta: Record<string, unknown> = {},
) => {
  c.var.logger.error({ err: error, ...meta }, scope);
  return c.json(
    { message: "Something went wrong. Try again later." },
    HTTP.InternalServerError,
  );
};
