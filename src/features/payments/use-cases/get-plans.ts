import { db } from "@d/connection";
import { plan as planTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import type { StripePlan } from "@better-auth/stripe";
import { eq, and, sql } from "drizzle-orm";

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
 * @description Active recurring plans in the shape better-auth's stripe plugin expects.
 * Passed as the plugin's `subscription.plans`, which it resolves on every subscription call.
 * @returns Array of StripePlans.
 */
export async function getSubscriptionPlans(): Promise<StripePlan[]> {
  const res = await db
    .select()
    .from(planTable)
    .where(and(eq(planTable.active, true), eq(planTable.type, "recurring")));
  return res.map((plan) => ({
    name: plan.name,
    priceId: plan.stripePriceId,
    annualDiscountPriceId: plan.annualDiscountPriceId ?? undefined,
    limits: plan.limits ?? undefined,
    freeTrial: plan.trialDays ? { days: plan.trialDays } : undefined,
  }));
}
