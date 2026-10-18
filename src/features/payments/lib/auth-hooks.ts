import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { rejectRetiredPlanUpgrade } from "@f/payments/lib/plan-retirement";
import { rejectProtectedUserFields } from "@f/payments/lib/protected-user-fields";
import { isUserDeleting } from "@f/payments/lib/state/deletion-guard";
import { paymentsServices } from "@f/payments/services";

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
  // lib/state/deletion-guard.ts). The after hook below is what actually closes the race
  if (ctx.path === UPGRADE_PATH) {
    const session = await getSessionFromCtx(ctx);
    if (session && (await isUserDeleting(session.user.id))) throw userDeletingError();
  }
});

/**
 * @description better-auth's global `hooks.after`, wired in `auth.ts`. Re-checks the deletion flag
 * once `/subscription/upgrade` has created its Checkout Session: if the user's deletion started in
 * the meantime, their open sessions are expired and the request fails instead of handing back a
 * payable URL (see lib/state/deletion-guard.ts for why checking again after creation closes the race).
 */
export const paymentsAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== UPGRADE_PATH) return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return;

  const guard = await paymentsServices.account.guardSubscriptionUpgrade(session.user.id);
  if (!guard.blocked) return;
  if (guard.reason === "flag_unreadable")
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong. Try again later.",
    });
  throw userDeletingError();
});
