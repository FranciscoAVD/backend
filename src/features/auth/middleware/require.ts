import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "@f/auth/middleware/session";
import { HTTP_STATUS } from "@/lib/http-status";

export type RequireSessionEnv = {
  Variables: {
    session: NonNullable<SessionEnv["Variables"]["session"]>;
  };
};
export const requireSessionMiddleware = createMiddleware<RequireSessionEnv>(
  async (c, next) => {
    const session = c.get("session") as SessionEnv["Variables"]["session"];
    if (!session) {
      return c.json({ message: "Unauthorized" }, HTTP_STATUS.UNAUTHORIZED);
    }
    await next();
  },
);
