import { db } from "@backend/d/connection";
import { plan as planTable } from "@backend/d/schemas/payment-schema";
import type { Payment } from "@backend/f/payments/lib/types";
import { eq } from "drizzle-orm";

/**
 * @description Update query for plan with a matching plan ID. No Stripe call - only
 * Stripe-independent policy fields are updatable (see Payment.Plan.Update/updatePlanSchema);
 * pricing/identity fields stay fixed to what addPlan created in Stripe. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param plan object of the plan's own ID, enforced by Pick<Payment.Plan, "id">
 * @param update object of updated fields, enforced by Payment.Plan.Update
 * @returns Plan object or null. If null, the query couldn't find a plan for the given ID.
 */
export async function updatePlan(
  plan: Pick<Payment.Plan, "id">,
  update: Payment.Plan.Update,
): Promise<Payment.Plan | null> {
  const res = await db
    .update(planTable)
    .set(update)
    .where(eq(planTable.id, plan.id))
    .returning();
  return res[0] ?? null;
}
