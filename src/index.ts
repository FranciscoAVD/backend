import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { cors } from "hono/cors";
import { env } from "@/env";
import { logger } from "@/lib/logger";
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

export default {
  port: env.SERVER_PORT,
  fetch: app.fetch,
};
