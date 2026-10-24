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
import { ok, serverError } from "@backend/lib/responses";

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
      return serverError(c, error, "todo.getAll", { user: user.id });
    }
    return ok(c, res, "Todos found", HTTP.OK);
  })
  .get("/:id", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [res, error] = await tryCatch(todoRepo.get.one({ id, userId: user.id }));

    if (error) {
      return serverError(c, error, "todo.get", { user: user.id, todo: id });
    }

    return !res
      ? c.json({ message: "Todo not found" }, HTTP.NotFound)
      : ok(c, res, "Todo found", HTTP.OK);
  })
  .use(writeRateLimit)
  .post(
    "/",
    requirePermissionMiddleware({ todo: ["create"] }),
    jsonValidator(todoSchemas.insert),
    async (c) => {
      const { user } = c.get("session");
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(
        todoRepo.add({ userId: user.id }, data),
      );

      if (error) {
        return serverError(c, error, "todo.add", { user: user.id });
      }

      if (!res) {
        return serverError(c, new Error("Could not create todo"), "todo.add", {
          user: user.id,
        });
      }

      return ok(c, res, "Todo created", HTTP.Created);
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
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(
        todoRepo.update({ id, userId: user.id }, data),
      );

      if (error) {
        return serverError(c, error, "todo.update", { user: user.id });
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
        return serverError(c, error, "todo.delete", { user: user.id });
      }

      return !res
        ? c.json({ message: "Todo not found" }, HTTP.NotFound)
        : ok(c, undefined, "Todo deleted", HTTP.OK);
    },
  );

export default app;
