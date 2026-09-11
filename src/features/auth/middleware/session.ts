// session-middleware.ts
import { createMiddleware } from "hono/factory";
import { auth } from "@f/auth/auth";

export type SessionEnv = {
  Variables: {
    session: typeof auth.$Infer.Session | null;
  };
};

export const sessionMiddleware = createMiddleware<SessionEnv>(
  async (c, next) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    c.set("session", session);
    await next();
  },
);
