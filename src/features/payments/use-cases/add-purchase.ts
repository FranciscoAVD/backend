import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";

/**
 * @description Idempotent insert query for a confirmed purchase. A purchase already recorded for the
 * same checkout session is left untouched, so webhook retries are safe. Assumes validation. Operation must be wrapped in try-catch
 * @param user object of user ID enforced by Pick<Payment.Purchase, "userID">
 * @param purchase object of insert fields enforced by Payment.Purchase.Insert
 * @returns Purchase object or null. If null, the purchase was already recorded.
 */
export async function addPurchase(
  user: Pick<Payment.Purchase, "userID">,
  purchase: Payment.Purchase.Insert,
): Promise<Payment.Purchase | null> {
  const res = await db
    .insert(purchaseTable)
    .values({ ...purchase, userID: user.userID })
    .onConflictDoNothing({ target: purchaseTable.stripeCheckoutSessionId })
    .returning();
  return res[0] ?? null;
}
