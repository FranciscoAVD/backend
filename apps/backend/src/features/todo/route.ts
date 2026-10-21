import { Hono } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@backend/f/auth/middleware";

import { todoSchemas } from "@backend/f/todo/lib/schemas";

import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { idParamValidator, jsonValidator } from "@backend/lib/validators";

import { rateLimiter } from "@backend/lib/rate-limit";

import { todoRepo } from "@backend/f/todo/repo";

const writeRateLimit = rateLimiter<RequireSessionEnv>({
  keyPrefix: "todo-write",
  windowSec: 60,
  max: 60,
  by: (c) => c.get("session").user.id,
});

// chained in one expression, all the way to the export: RPC's inferred
// AppType only picks up routes/validators registered on the exact value
// assigned to `app`, not ones added via a later, separate statement
const app = new Hono<PinoLoggerEnv>()
  .use(sessionMiddleware)
  .use(requireSessionMiddleware)
  .get("/", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(todoRepo.get.all({ userId: user.id }));
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "todo.getAll");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }
    return c.json({ data: res, message: "Todos found" }, HTTP.OK);
  })
  .get("/:id", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [res, error] = await tryCatch(todoRepo.get.one({ id, userId: user.id }));

    if (error) {
      c.var.logger.error({ err: error, user: user.id, todo: id }, "todo.get");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }

    return !res
      ? c.json({ message: "Todo not found" }, HTTP.NotFound)
      : c.json({ data: res, message: "Todo found" }, HTTP.OK);
  })
  .use(writeRateLimit)
  .post(
    "/",
    requirePermissionMiddleware({ todo: ["create"] }),
    jsonValidator(todoSchemas.insert),
    async (c) => {
      const { user } = c.get("session");
      const body = c.req.valid("json");

      const [res, error] = await tryCatch(
        todoRepo.add({ userId: user.id }, body.data),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "todo.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) {
        c.var.logger.error(
          { err: new Error("Could not create todo"), user: user.id },
          "todo.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return c.json(
        { data: res, message: "Todo created" },
        HTTP.Created,
      );
    },
  )
  .patch(
    "/:id",
    idParamValidator,
    requirePermissionMiddleware({ todo: ["update"] }),
    jsonValidator(todoSchemas.update),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");
      const { data } = c.req.valid("json");

      const [res, error] = await tryCatch(
        todoRepo.update({ id, userId: user.id }, data),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "todo.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return !res
        ? c.json({ message: "Todo not found" }, HTTP.NotFound)
        : c.body(null, HTTP.NoContent);
    },
  )
  .delete(
    "/:id",
    idParamValidator,
    requirePermissionMiddleware({ todo: ["delete"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { user } = c.get("session");

      const [res, error] = await tryCatch(todoRepo.delete({ id, userId: user.id }));

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "todo.delete");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return !res
        ? c.json({ message: "Todo not found" }, HTTP.NotFound)
        : c.json({ message: "Todo deleted" }, HTTP.OK);
    },
  );

export default app;
