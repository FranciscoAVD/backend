import { createAuthMiddleware } from "@vicstack/auth-middleware";
import { auth } from "@backend/f/auth/auth";
import { statement } from "@backend/f/auth/lib/permissions";

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
