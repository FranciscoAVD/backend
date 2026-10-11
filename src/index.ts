import { Hono } from "hono";
import { pinoLogger, type Env as PinoLoggerEnv } from "hono-pino";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import HTTP from "@vicstack/http";
import authRoute from "@f/auth/route";
import todoRoute from "@f/todo/route";
import paymentsRoute from "@f/payments/route";
import { healthRoute } from "@/lib/health";

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
