import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import tryCatch from "@vicstack/try-catch";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { logger } from "@/lib/logger";
import { rejectRetiredPlanUpgrade } from "@f/payments/lib/plan-retirement";
import { rejectProtectedUserFields } from "@f/payments/lib/protected-user-fields";
import { isUserDeleting } from "@f/payments/lib/deletion-guard";
import { expireCheckoutsForDeletedUser } from "@f/payments/lib/user-deletion";

const UPGRADE_PATH = "/subscription/upgrade";

const userDeletingError = () =>
  new APIError("CONFLICT", {
    message: "This account is being deleted",
    code: "ACCOUNT_BEING_DELETED",
  });

/**
 * @description better-auth's global `hooks.before`, wired in `auth.ts`. better-auth takes a single
 * handler here, so every payments check that has to run in front of a better-auth endpoint lives
 * behind this one.
 */
export const paymentsBeforeHook = createAuthMiddleware(async (ctx) => {
  rejectProtectedUserFields(ctx);
  await rejectRetiredPlanUpgrade(ctx);

  // fail fast: no new subscription checkout for a user whose deletion has started (see
  // lib/deletion-guard.ts). The after hook below is what actually closes the race
  if (ctx.path === UPGRADE_PATH) {
    const session = await getSessionFromCtx(ctx);
    if (session && (await isUserDeleting(session.user.id))) throw userDeletingError();
  }
});

/**
 * @description better-auth's global `hooks.after`, wired in `auth.ts`. Re-checks the deletion flag
 * once `/subscription/upgrade` has created its Checkout Session: if the user's deletion started in
 * the meantime, their open sessions are expired and the request fails instead of handing back a
 * payable URL (see lib/deletion-guard.ts for why checking again after creation closes the race).
 */
export const paymentsAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== UPGRADE_PATH) return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return;

  const [deleting, flagError] = await tryCatch(isUserDeleting(session.user.id));
  // a Redis failure here almost certainly failed the deletion hook's own flag write too, which
  // aborts the deletion - so let the checkout through rather than failing a normal purchase
  if (flagError) {
    logger.warn({ err: flagError, user: session.user.id }, "payments.deletion_guard.check");
    return;
  }
  if (!deleting) return;

  // read live, not from the (possibly cached) session
  const [row] = await db
    .select({ stripeCustomerId: userTable.stripeCustomerId })
    .from(userTable)
    .where(eq(userTable.id, session.user.id));
  const [, expireError] = await tryCatch(
    expireCheckoutsForDeletedUser({
      id: session.user.id,
      stripeCustomerId: row?.stripeCustomerId,
    }),
  );
  if (expireError)
    logger.error(
      { err: expireError, user: session.user.id },
      "payments.deletion_guard.expire_subscription_checkout",
    );
  throw userDeletingError();
});
