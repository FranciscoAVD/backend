import pino from "pino";
import type { HttpLoggerOptions } from "hono-pino";
import { env } from "@/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  // hono-pino's default request/response bindings log every header verbatim - cookie (the
  // better-auth session token), authorization, stripe-signature, and a sign-in response's
  // set-cookie included. Anyone who can read the logs could lift a session straight out of them.
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      'req.headers["stripe-signature"]',
      'res.headers["set-cookie"]',
      "res.headers.location",
    ],
    censor: "[Redacted]",
  },
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        }
      : undefined,
});

// hono-pino's default onResBindings hands pino the raw Fetch `Headers` instance for c.res.headers.
// fast-redact (which backs pino's `redact` above) works by direct property access on a plain
// object graph - `Headers` doesn't expose header values as settable/gettable bracket properties,
// so the res.headers["set-cookie"] path above finds nothing there and silently no-ops (in one
// observed case it broke serialization of the whole `res` object instead). Flattening to a plain
// object first is what makes that redact path actually take effect - confirmed empirically.
//
// better-auth's own GET /reset-password/:token redirect-helper endpoint puts the reset token
// directly in the URL *path* (not a query param, which the default req binding below would
// already exclude) - confirmed in its source, node_modules/better-auth/dist/api/routes/password.mjs.
// redact can't reach into the middle of a string value, so this needs its own onReqBindings to
// mask it out before logging, rather than a redact path.
const RESET_PASSWORD_TOKEN_PATH = /\/reset-password\/[^/?]+/;

export const httpLoggerOptions: {
  onReqBindings: HttpLoggerOptions["onReqBindings"];
  onResBindings: HttpLoggerOptions["onResBindings"];
} = {
  onReqBindings: (c) => ({
    req: {
      url: c.req.path.replace(RESET_PASSWORD_TOKEN_PATH, "/reset-password/[Redacted]"),
      method: c.req.method,
      headers: c.req.header(),
    },
  }),
  onResBindings: (c) => ({
    res: { status: c.res.status, headers: Object.fromEntries(c.res.headers.entries()) },
  }),
};
