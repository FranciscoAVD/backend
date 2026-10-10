import { createAuthMiddleware } from "@vicstack/auth-middleware";
import { auth } from "@f/auth/auth";
import { statement } from "@f/auth/lib/permissions";

export const {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
} = createAuthMiddleware(auth, statement);

export type RequireSessionEnv = {
  Variables: {
    session: NonNullable<typeof auth.$Infer.Session>;
  };
};
