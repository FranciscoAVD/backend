import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "@f/auth/middleware/session";

export type RequireSessionEnv = {
  Variables: {
    session: NonNullable<SessionEnv["Variables"]["session"]>;
  };
};
export const requireSessionMiddleware = createMiddleware<RequireSessionEnv>(
  async (c, next) => {
    const session = c.get("session") as SessionEnv["Variables"]["session"];
    if (!session) {
      return c.json({ message: "Unauthorized" }, 401);
    }
    await next();
  },
);
