import { Hono } from "hono";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@f/auth/middleware";

import { insertTodoSchema, updateTodoSchema } from "@f/todo/lib/schemas";

import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { idParamValidator, jsonValidator } from "@/lib/validators";

import { rateLimiter } from "@/lib/rate-limit";

import { getAllTodos, getTodo } from "@f/todo/use-cases/get";
import { addTodo } from "@f/todo/use-cases/add";
import { updateTodo } from "@f/todo/use-cases/update";
import { deleteTodo } from "@f/todo/use-cases/remove";

const writeRateLimit = rateLimiter<RequireSessionEnv>({
  keyPrefix: "todo-write",
  windowSec: 60,
  max: 60,
  by: (c) => c.get("session").user.id,
});

const app = new Hono();

app
  .use(sessionMiddleware)
  .use(requireSessionMiddleware)
  .get("/", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(getAllTodos({ userID: user.id }));
    if (error) {
      logger.error({ err: error, user: user.id }, "todo.getAll");
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

    const [res, error] = await tryCatch(getTodo({ id, userID: user.id }));

    if (error) {
      logger.error({ err: error, user: user.id, todo: id }, "todo.get");
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
    jsonValidator(insertTodoSchema),
    async (c) => {
      const { user } = c.get("session");
      const body = c.req.valid("json");

      const [res, error] = await tryCatch(
        addTodo({ userID: user.id }, body.data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) {
        logger.error(
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
    jsonValidator(updateTodoSchema),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");
      const { data } = c.req.valid("json");

      const [res, error] = await tryCatch(
        updateTodo({ id, userID: user.id }, data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.update");
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

      const [res, error] = await tryCatch(deleteTodo({ id, userID: user.id }));

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.delete");
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
