import { db } from "@d/connection";
import { plan as planTable, purchase as purchaseTable } from "@d/schemas/payment-schema";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import type { Payment } from "@f/payments/lib/types";
import { isPurchaseAccessActive } from "@f/payments/lib/utils";
import {
  PURCHASE_ACCESS_STATUSES,
  RETIRED_PLANS_KEEP_ACCESS,
  SUBSCRIPTION_ACCESS_STATUSES,
} from "@f/payments/lib/access-policy";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

/**
 * @description Every plan the user has access to right now, across both plan types: one-time
 * plans with a purchase whose window covers now (same rules as `hasActivePurchase`, including
 * `overlapping`), and recurring plans with a subscription in an access-granting status (same
 * rules as `hasActiveSubscription`). Each plan comes back whole, `limits` included - how to
 * combine several plans' limits into one answer (highest wins, add up, any-true, ...) depends on
 * what the limits mean, so that's left to the app. Retired plans are included or not per
 * `RETIRED_PLANS_KEEP_ACCESS`. Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the caller's own user ID
 * @returns Array of Plans the user currently has access to, ordered by plan ID, no duplicates.
 */
export async function getActivePlans(
  target: { userId: string },
): Promise<Payment.Plan[]> {
  const [purchases, subscribed] = await Promise.all([
    db
      .select({ plan: planTable, purchase: purchaseTable })
      .from(purchaseTable)
      .innerJoin(planTable, eq(purchaseTable.planId, planTable.id))
      .where(
        and(
          eq(purchaseTable.userId, target.userId),
          inArray(purchaseTable.status, PURCHASE_ACCESS_STATUSES),
        ),
      )
      .orderBy(asc(purchaseTable.createdAt)),
    // matched by name, case-insensitively, the same way the stripe plugin and
    // hasActiveSubscription resolve a subscription's plan
    db
      .selectDistinct({ plan: planTable })
      .from(subscriptionTable)
      .innerJoin(
        planTable,
        and(
          eq(planTable.type, "recurring"),
          sql`lower(${planTable.name}) = lower(${subscriptionTable.plan})`,
        ),
      )
      .where(
        and(
          eq(subscriptionTable.referenceId, target.userId),
          inArray(subscriptionTable.status, SUBSCRIPTION_ACCESS_STATUSES),
        ),
      ),
  ]);

  const active = new Map<number, Payment.Plan>();

  // purchases arrive sorted by createdAt, so each plan's group stays sorted too
  const byPlan = new Map<number, { plan: Payment.Plan; purchases: Payment.Purchase[] }>();
  for (const row of purchases) {
    const group = byPlan.get(row.plan.id) ?? { plan: row.plan, purchases: [] };
    group.purchases.push(row.purchase);
    byPlan.set(row.plan.id, group);
  }
  const now = new Date();
  for (const { plan, purchases: rows } of byPlan.values())
    if (isPurchaseAccessActive(rows, plan, now)) active.set(plan.id, plan);

  for (const { plan } of subscribed) active.set(plan.id, plan);

  return [...active.values()]
    .filter((plan) => RETIRED_PLANS_KEEP_ACCESS || plan.active)
    .sort((a, b) => a.id - b.id);
}
