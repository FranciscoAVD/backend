import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @description Idempotent insert query for a confirmed purchase. A purchase already recorded for the
 * same checkout session is left untouched, so webhook retries are safe. `expiresAt` is computed from
 * the plan's durationDays at insert time, independent of any other purchase of the same plan (purchases
 * of a plan can overlap). Assumes validation. Operation must be wrapped in try-catch
 * @param user object of the purchasing user's own (always real, live) user ID - never null,
 * unlike a purchase row's own userId once that user is later deleted
 * @param purchase object of insert fields enforced by Payment.Purchase.Insert
 * @param plan object of the purchased plan's duration, enforced by Pick<Payment.Plan, "durationDays">
 * @returns Purchase object or null. If null, the purchase was already recorded.
 */
export async function addPurchase(
  user: { userId: string },
  purchase: Payment.Purchase.Insert,
  plan: Pick<Payment.Plan, "durationDays">,
): Promise<Payment.Purchase | null> {
  const expiresAt = plan.durationDays
    ? new Date(Date.now() + plan.durationDays * DAY_MS)
    : null;

  const res = await db
    .insert(purchaseTable)
    .values({ ...purchase, userId: user.userId, expiresAt })
    .onConflictDoNothing({ target: purchaseTable.stripeCheckoutSessionId })
    .returning();
  return res[0] ?? null;
}
