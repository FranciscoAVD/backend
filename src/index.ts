import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { env } from "@/env";
import authRoute from "@f/auth/routes/auth";
import todoRoute from "@f/todo/routes/todo";

const app = new Hono().basePath("/api");
app.use(logger());
app.use(
  "*",
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  }),
);
app.route("/auth", authRoute);
app.route("/todo", todoRoute);

export default {
  port: env.SERVER_PORT,
  fetch: app.fetch,
};
