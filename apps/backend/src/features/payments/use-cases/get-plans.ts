import { db } from "@backend/d/connection";
import { plan as planTable } from "@backend/d/schemas/payment-schema";
import type { Payment } from "@backend/f/payments/lib/types";
import type { StripePlan } from "@better-auth/stripe";
import { eq, or, sql } from "drizzle-orm";

/**
 * @description Select query for all active plans. Operation must be wrapped in try-catch
 * @returns Array of Plans.
 */
export async function getPlans(): Promise<Payment.Plan[]> {
  const res = await db
    .select()
    .from(planTable)
    .where(eq(planTable.active, true));
  return res;
}

/**
 * @description Select query for every plan regardless of `active` - admin-only
 * (`plan:read:all`) at the route layer; this function itself has no notion of permissions.
 * @returns Array of Plans.
 */
export async function getAllPlansIncludingInactive(): Promise<Payment.Plan[]> {
  return db.select().from(planTable);
}

/**
 * @description Select query for plan with a matching plan ID. Assumes validation. Operation must be wrapped in try-catch
 * @param plan object of plan ID enforced by Pick<Payment.Plan, "id">
 * @returns Plan object or null. If null, the query couldn't find a plan for the given constraints.
 */
export async function getPlan(
  plan: Pick<Payment.Plan, "id">,
): Promise<Payment.Plan | null> {
  const res = await db.select().from(planTable).where(eq(planTable.id, plan.id));
  return res[0] ?? null;
}

/**
 * @description Case-insensitive select query for plan with a matching name, mirroring how the
 * stripe plugin resolves plans. Assumes validation. Operation must be wrapped in try-catch
 * @param plan object of plan name enforced by Pick<Payment.Plan, "name">
 * @returns Plan object or null. If null, no plan uses that name.
 */
export async function getPlanByName(
  plan: Pick<Payment.Plan, "name">,
): Promise<Payment.Plan | null> {
  const res = await db
    .select()
    .from(planTable)
    .where(sql`lower(${planTable.name}) = lower(${plan.name})`);
  return res[0] ?? null;
}

/**
 * @description Select query for the recurring plan whose current price matches the given Stripe
 * price ID - mirrors `@better-auth/stripe`'s own `resolvePlanItem`, which matches a subscription's
 * current price against `priceId`/`annualDiscountPriceId` the same way, so a subscription's plan
 * can be re-derived the same way the plugin itself would. Assumes validation. Operation must be
 * wrapped in try-catch
 * @param priceId the Stripe price ID to match, from a subscription's current item
 * @returns Plan object or null. If null, no configured plan currently prices at that ID.
 */
export async function getPlanByPriceId(
  priceId: string,
): Promise<Payment.Plan | null> {
  const res = await db
    .select()
    .from(planTable)
    .where(
      or(
        eq(planTable.stripePriceId, priceId),
        eq(planTable.annualDiscountPriceId, priceId),
      ),
    );
  return res[0] ?? null;
}

/**
 * @description Every recurring plan, retired (`active: false`) ones included, in the shape
 * better-auth's stripe plugin expects. Passed as the plugin's `subscription.plans`, which it
 * resolves on every subscription call. Retired plans stay in the list so the plugin still
 * recognizes the plan of a subscription that already exists; new subscriptions to them are
 * blocked by `rejectRetiredPlanUpgrade` instead (see `lib/plan-retirement.ts` for why).
 * @returns Array of StripePlans.
 */
export async function getSubscriptionPlans(): Promise<StripePlan[]> {
  const res = await db
    .select()
    .from(planTable)
    .where(eq(planTable.type, "recurring"));
  return res.map((plan) => ({
    name: plan.name,
    priceId: plan.stripePriceId,
    annualDiscountPriceId: plan.annualDiscountPriceId ?? undefined,
    limits: plan.limits ?? undefined,
    freeTrial: plan.trialDays ? { days: plan.trialDays } : undefined,
  }));
}
