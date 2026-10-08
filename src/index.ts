import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { HTTP_STATUS } from "@/lib/http-status";
import authRoute from "@f/auth/routes/auth";
import todoRoute from "@f/todo/routes/todo";
import paymentsRoute from "@f/payments/routes/payments";

const app = new Hono().basePath("/api");
app.use(pinoLogger({ pino: logger }));
app.use(
  "*",
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  }),
);
app.route("/auth", authRoute);
app.route("/todo", todoRoute);
if (env.PAYMENTS_ENABLED) {
  app.route("/payments", paymentsRoute);
}

// errors thrown anywhere, including middleware, that a handler didn't catch
app.onError((err, c) => {
  // e.g. hono's validator throws a 400 on a malformed JSON body
  if (err instanceof HTTPException) return err.getResponse();

  logger.error(
    { err, method: c.req.method, path: c.req.path },
    "app.unhandled",
  );
  return c.json(
    { message: "Something went wrong. Try again later." },
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
  );
});

export default {
  port: env.SERVER_PORT,
  fetch: app.fetch,
};
