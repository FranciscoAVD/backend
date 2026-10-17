import { paymentsRepo } from "@f/payments/repo";
import { logger } from "@/lib/logger";

/**
 * @description `subscription.getCheckoutSessionParams` for `@better-auth/stripe`, wired in `auth.ts`:
 * withholds a recurring plan's free trial from a user whose email isn't verified.
 *
 * The plugin grants one trial per account (it checks the account's own subscription history).
 * Signing in now requires a verified email, so this is mostly defense-in-depth - a user verified
 * before that requirement shipped, or any future path that creates a session without setting
 * `emailVerified`, could otherwise still farm trials across throwaway accounts. Tying the trial to
 * a verified email makes it one trial per mailbox, since a verified email can only belong to one
 * account.
 *
 * Works by overriding the plugin's `trial_period_days`: the plugin spreads these params' own
 * `subscription_data` over the trial it computed, and the Stripe SDK drops `undefined` params, so
 * the session is created without one. Read live, not from the (possibly cached) session user.
 */
export async function withholdTrialFromUnverified(data: {
  user: { id: string };
  plan: { name: string; freeTrial?: unknown };
}): Promise<{ params?: { subscription_data?: { trial_period_days?: number } } }> {
  if (!data.plan.freeTrial) return {};

  const row = await paymentsRepo.user.getEmailVerified({ userId: data.user.id });
  if (row?.emailVerified) return {};

  logger.info({ user: data.user.id, plan: data.plan.name }, "payments.trial.withheld_unverified");
  return { params: { subscription_data: { trial_period_days: undefined } } };
}
