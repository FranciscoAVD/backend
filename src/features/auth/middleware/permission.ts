import { createMiddleware } from "hono/factory";
import { auth } from "@f/auth/auth";
import type { RequireSessionEnv } from "@f/auth/middleware/require";
import type { statement } from "@f/auth/lib/permissions";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";
import { HTTP_STATUS } from "@/lib/http-status";

type Statement = typeof statement;
type Permissions = {
  [Resource in keyof Statement]?: Statement[Resource][number][];
};

/**
 * @description Answers 403 unless the session user has every listed permission.
 * Must run after `requireSessionMiddleware`.
 */
export const requirePermission = (permissions: Permissions) => {
  const scope = `auth.permission.${Object.entries(permissions)
    .map(([resource, actions]) => `${resource}.${actions?.join(",")}`)
    .join(".")}`;

  return createMiddleware<RequireSessionEnv>(async (c, next) => {
    const { user } = c.get("session");

    const [can, error] = await tryCatch(
      auth.api.userHasPermission({
        body: { userId: user.id, permissions },
      }),
    );

    if (error) {
      logger.error(
        { err: error, user: user.id, params: c.req.param() },
        scope,
      );
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    if (!can.success)
      return c.json({ message: "Unauthorized" }, HTTP_STATUS.FORBIDDEN);

    await next();
  });
};
