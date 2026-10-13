import { db } from "@d/connection";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import type { Payment } from "@f/payments/lib/types";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  SUBSCRIPTION_ACCESS_STATUSES,
  SUBSCRIPTION_TERMINAL_STATUSES,
} from "@f/payments/lib/access-policy";

export type Subscription = typeof subscriptionTable.$inferSelect;

/**
 * @description Whether the user currently has an active or trialing subscription to the given
 * plan. Mirrors `isActiveOrTrialing`, the same active-state definition the better-auth stripe
 * plugin itself uses internally (e.g. to block a duplicate upgrade), so this stays consistent
 * with what the plugin considers "subscribed" instead of inventing a second definition. Matches
 * `subscription.plan` against the plan name case-insensitively, same as the plugin's own plan
 * lookup. Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the caller's own user ID - the plugin always keys subscriptions by
 * user here, never organization, since the org plugin isn't enabled
 * @param plan object of the plan's name, enforced by Pick<Payment.Plan, "name">
 * @returns Whether the user currently has subscription access to the plan.
 */
export async function hasActiveSubscription(
  target: { userId: string },
  plan: Pick<Payment.Plan, "name">,
): Promise<boolean> {
  const res = await db
    .select({ id: subscriptionTable.id })
    .from(subscriptionTable)
    .where(
      and(
        eq(subscriptionTable.referenceId, target.userId),
        sql`lower(${subscriptionTable.plan}) = lower(${plan.name})`,
        inArray(subscriptionTable.status, SUBSCRIPTION_ACCESS_STATUSES),
      ),
    );
  return res.length > 0;
}

/**
 * @description Every subscription row not already in a terminal state (`canceled` or
 * `incomplete_expired` - Stripe guarantees these never change again), for the reconciler to
 * re-check against Stripe. Scoped this way, not by every subscription ever created, so call
 * volume stays bounded by currently live-ish subscriber count rather than all-time history -
 * most of which has already settled and will never need re-checking. Assumes validation.
 * Operation must be wrapped in try-catch
 * @returns Every subscription row that could still change.
 */
export async function getReconcilableSubscriptions(): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptionTable)
    .where(notInArray(subscriptionTable.status, [...SUBSCRIPTION_TERMINAL_STATUSES]));
}
