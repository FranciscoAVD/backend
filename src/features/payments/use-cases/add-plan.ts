import { db } from "@d/connection";
import { plan as planTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";

/**
 * @description Insert query for a plan - the Stripe product/price(s) must already exist
 * (`services/plan.ts`'s `create` makes them and fills in `stripeProductId`/`stripePriceId`/
 * `annualDiscountPriceId` before calling this). Assumes validation. Operation must be
 * wrapped in try-catch
 * @param plan object of insert fields enforced by Payment.Plan.Insert, plus the Stripe ids
 * `services/plan.ts` filled in
 * @returns Plan object or null. If null, the insert didn't return a row.
 */
export async function addPlan(
  plan: Payment.Plan.Insert & {
    stripeProductId: string;
    stripePriceId: string;
    annualDiscountPriceId: string | null;
  },
): Promise<Payment.Plan | null> {
  const res = await db.insert(planTable).values(plan).returning();
  return res[0] ?? null;
}
