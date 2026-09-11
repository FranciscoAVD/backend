import { Hono } from "hono";
import { validator } from "hono/validator";

import { auth } from "@/features/auth/auth";
import { sessionMiddleware } from "@f/auth/middleware/session";
import { requireSessionMiddleware } from "@f/auth/middleware/require";

import { z } from "zod";
import { insertTodoSchema, updateTodoSchema } from "@f/todo/lib/schemas";

import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";

import { idParamValidator } from "@/lib/validators";

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
      return c.json({ message: "Something went wrong. Try again later." }, 500);
    }
    return c.json({ data: res, message: "Todos found" }, 200);
  })
  .get("/:id", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [res, error] = await tryCatch(getTodo({ id, userID: user.id }));

    if (error) {
      logger.error({ err: error, user: user.id, todo: id }, "todo.get");
      return c.json({ message: "Something went wrong. Try again later." }, 500);
    }

    return !res
      ? c.json({ message: "Todo not found" }, 404)
      : c.json({ data: res, message: "Todo found" }, 200);
  })
  .use(writeRateLimit)
  .post(
    "/",
    validator("json", (value, c) => {
      const { success, data, error } = insertTodoSchema.safeParse(value);
      if (!success)
        return c.json(
          {
            error: z.treeifyError(error).properties,
            message: "Failed to parse",
          },
          422,
        );
      return {
        data,
      };
    }),
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
          500,
        );
      }

      if (!can.success) return c.json({ message: "Unauthorized" }, 403);

      const [res, error] = await tryCatch(
        addTodo({ userID: user.id }, body.data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          500,
        );
      }

      if (!res) {
        logger.error(
          { err: new Error("Could not create todo"), user: user.id },
          "todo.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          500,
        );
      }

      return c.json({ data: res, message: "Todo created" }, 201);
    },
  )
  .patch(
    "/:id",
    idParamValidator,
    validator("json", (value, c) => {
      const { success, data, error } = updateTodoSchema.safeParse(value);
      if (!success)
        return c.json(
          {
            error: z.treeifyError(error).properties,
            message: "Failed to parse",
          },
          422,
        );
      return {
        data,
      };
    }),
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
          500,
        );
      }

      if (!can.success) return c.json({ message: "Unauthorized" }, 403);

      const [res, error] = await tryCatch(
        updateTodo({ id, userID: user.id }, data),
      );

      if (error) {
        logger.error({ err: error, user: user.id }, "todo.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          500,
        );
      }

      return !res
        ? c.json({ message: "Todo not found" }, 404)
        : c.body(null, 204);
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
      return c.json({ message: "Something went wrong. Try again later." }, 500);
    }

    if (!can.success) return c.json({ message: "Unauthorized" }, 403);

    const [res, error] = await tryCatch(deleteTodo({ id, userID: user.id }));

    if (error) {
      logger.error({ err: error, user: user.id }, "todo.delete");
      return c.json({ message: "Something went wrong. Try again later." }, 500);
    }

    return !res
      ? c.json({ message: "Todo not found" }, 404)
      : c.json({ message: "Todo deleted" }, 200);
  });

export default app;
