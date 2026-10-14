import { Hono } from "hono";
import { pinoLogger, type Env as PinoLoggerEnv } from "hono-pino";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import HTTP from "@vicstack/http";
import authRoute from "@f/auth/route";
import todoRoute from "@f/todo/route";
import paymentsRoute from "@f/payments/route";
import { healthRoute } from "@/lib/health";

// every request body except the Stripe webhook's (capped separately below, at 1 MB): nothing this API
// accepts comes close - the largest is a plan with its `limits` JSON - and without a cap, anyone,
// signed in or not (sign-up), could stream an arbitrarily large body into a JSON parser
const API_BODY_LIMIT_BYTES = 100 * 1024;
const STRIPE_WEBHOOK_PATH = "/api/auth/stripe/webhook";
const apiBodyLimit = bodyLimit({
  maxSize: API_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ message: "Payload too large" }, HTTP.PayloadTooLarge),
});

const apiApp = new Hono<PinoLoggerEnv>()
  .basePath("/api")
  // before pinoLogger, so every request/response log line carries this request's id
  .use(requestId())
  .use(pinoLogger({ pino: logger }))
  .use(secureHeaders())
  .use(
    "*",
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    }),
  )
  .use("*", (c, next) => (c.req.path === STRIPE_WEBHOOK_PATH ? next() : apiBodyLimit(c, next)))
  // the Stripe webhook is exempt from better-auth's rate limiter (it's authenticated by its
  // signature instead - see auth.ts), and better-auth reads and HMACs the whole body before it can
  // reject a forgery, so this is what stops anyone streaming arbitrarily large junk at it.
  // Real Stripe events are a few KB, far under the cap
  .use(
    "/auth/stripe/webhook",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ message: "Payload too large" }, HTTP.PayloadTooLarge),
    }),
  )
  .route("/auth", authRoute)
  .route("/todo", todoRoute)
  .route("/payments", paymentsRoute);

// errors thrown anywhere, including middleware, that a handler didn't catch
apiApp.onError((err, c) => {
  // e.g. hono's validator throws a 400 on a malformed JSON body
  if (err instanceof HTTPException) return err.getResponse();

  c.var.logger.error(
    { err, method: c.req.method, path: c.req.path },
    "app.unhandled",
  );
  return c.json(
    { message: "Something went wrong. Try again later." },
    HTTP.InternalServerError,
  );
});

export type AppType = typeof apiApp;

const app = new Hono().route("/", healthRoute).route("/", apiApp);

export default {
  port: env.SERVER_PORT,
  fetch: app.fetch,
};
