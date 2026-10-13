import { APIError, createAuthMiddleware } from "better-auth/api";
import { paymentsRepo } from "@f/payments/repo";

/**
 * @description Stops new subscriptions to a retired (`active: false`) recurring plan. Wired as
 * better-auth's global `hooks.before` in `auth.ts`.
 *
 * Why this exists instead of just leaving retired plans out of the plugin's plan list: the plugin
 * uses that one list for two different jobs - deciding what can be subscribed to, and recognizing
 * the plan of a subscription that already exists. Leaving a retired plan out of it breaks the
 * second job for everyone still subscribed: `/subscription/list` returns them with no `limits` or
 * `priceId`, and for a multi-item subscription the plugin's `customer.subscription.updated`
 * handler stops syncing the row at all. So `getSubscriptionPlans` passes every recurring plan,
 * retired ones included, and this hook takes over the first job.
 *
 * It answers exactly like the plugin does for an unknown plan, so a retired plan looks the same as
 * one that never existed. It also blocks switching an existing subscription of that plan between
 * monthly and annual, which goes through the same endpoint - retiring a plan means no new
 * commitments to it.
 */
export const blockRetiredPlanUpgrade = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/subscription/upgrade") return;
  const name = (ctx.body as { plan?: unknown } | undefined)?.plan;
  // anything malformed is left to the plugin's own body validation
  if (typeof name !== "string") return;

  const plan = await paymentsRepo.plan.getByName({ name });
  if (plan && plan.type === "recurring" && !plan.active)
    throw new APIError("BAD_REQUEST", {
      message: "Subscription plan not found",
      code: "SUBSCRIPTION_PLAN_NOT_FOUND",
    });
});
