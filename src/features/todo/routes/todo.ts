import { Hono } from "hono";

import { auth } from "@/features/auth/auth";
import { sessionMiddleware } from "@f/auth/middleware/session";
import { requireSessionMiddleware } from "@f/auth/middleware/require";

import { insertTodoSchema, updateTodoSchema } from "@f/todo/lib/schemas";

import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";
import { HTTP_STATUS } from "@/lib/http-status";

import { idParamValidator, jsonValidator } from "@/lib/validators";

import { rateLimiter } from "@/lib/rate-limit";

import { getAllTodos, getTodo } from "@f/todo/use-cases/get";
import { addTodo } from "@f/todo/use-cases/add";
import { updateTodo } from "@f/todo/use-cases/update";
import { deleteTodo } from "@f/todo/use-cases/remove";

const writeRateLimit = rateLimiter({
  keyPrefix: "todo-write",
  windowSec: 60,
  max: 60,
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
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }
    return c.json({ data: res, message: "Todos found" }, HTTP_STATUS.SUCCESS);
  })
  .get("/:id", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [res, error] = await tryCatch(getTodo({ id, userID: user.id }));

    if (error) {
      logger.error({ err: error, user: user.id, todo: id }, "todo.get");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    return !res
      ? c.json({ message: "Todo not found" }, HTTP_STATUS.NOT_FOUND)
      : c.json({ data: res, message: "Todo found" }, HTTP_STATUS.SUCCESS);
  })
  .use(writeRateLimit)
  .post(
    "/",
    jsonValidator(insertTodoSchema),
    async (c) => {
      const { user } = c.get("session");
      const body = c.req.valid("json");

      const [can, canError] = await tryCatch(
        auth.api.userHasPermission({
          body: {
            userId: user.id,
            permissions: {
              todo: ["create"],
            },
          },
        }),
      );

      if (canError) {
        logger.error(
          { err: canError, user: user.id },
          "auth.permission.todo.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!can.success)
        return c.json({ message: "Unauthorized" }, HTTP_STATUS.FORBIDDEN);

      const [res, error] = await tryCatch(
        addTodo({ userID: user.id }, body.data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!res) {
        logger.error(
          { err: new Error("Could not create todo"), user: user.id },
          "todo.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      return c.json(
        { data: res, message: "Todo created" },
        HTTP_STATUS.CREATED,
      );
    },
  )
  .patch(
    "/:id",
    idParamValidator,
    jsonValidator(updateTodoSchema),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");
      const { data } = c.req.valid("json");

      const [can, canError] = await tryCatch(
        auth.api.userHasPermission({
          body: {
            userId: user.id,
            permissions: {
              todo: ["update"],
            },
          },
        }),
      );

      if (canError) {
        logger.error(
          { err: canError, todo: id, user: user.id },
          "auth.permission.todo.update",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!can.success)
        return c.json({ message: "Unauthorized" }, HTTP_STATUS.FORBIDDEN);

      const [res, error] = await tryCatch(
        updateTodo({ id, userID: user.id }, data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      return !res
        ? c.json({ message: "Todo not found" }, HTTP_STATUS.NOT_FOUND)
        : c.body(null, HTTP_STATUS.NO_CONTENT);
    },
  )
  .delete("/:id", idParamValidator, async (c) => {
    const { id } = c.req.valid("param");
    const { user } = c.get("session");

    const [can, canError] = await tryCatch(
      auth.api.userHasPermission({
        body: {
          userId: user.id,
          permissions: {
            todo: ["delete"],
          },
        },
      }),
    );

    if (canError) {
      logger.error(
        { err: canError, todo: id, user: user.id },
        "auth.permission.todo.delete",
      );
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    if (!can.success)
      return c.json({ message: "Unauthorized" }, HTTP_STATUS.FORBIDDEN);

    const [res, error] = await tryCatch(deleteTodo({ id, userID: user.id }));

    if (error) {
      logger.error({ err: error, user: user.id }, "todo.delete");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    return !res
      ? c.json({ message: "Todo not found" }, HTTP_STATUS.NOT_FOUND)
      : c.json({ message: "Todo deleted" }, HTTP_STATUS.SUCCESS);
  });

export default app;
