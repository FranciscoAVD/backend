import { eq } from "drizzle-orm";
import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { logger } from "@/lib/logger";

/**
 * @description `subscription.getCheckoutSessionParams` for `@better-auth/stripe`, wired in `auth.ts`:
 * withholds a recurring plan's free trial from a user whose email isn't verified.
 *
 * The plugin grants one trial per account (it checks the account's own subscription history), and
 * sign-up needs no email verification - so without this, every throwaway account gets the trial
 * again. Tying the trial to a verified email makes it one trial per mailbox, since a verified email
 * can only belong to one account. An unverified user can still subscribe; they just pay from day one.
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

  const [row] = await db
    .select({ emailVerified: userTable.emailVerified })
    .from(userTable)
    .where(eq(userTable.id, data.user.id));
  if (row?.emailVerified) return {};

  logger.info({ user: data.user.id, plan: data.plan.name }, "payments.trial.withheld_unverified");
  return { params: { subscription_data: { trial_period_days: undefined } } };
}
