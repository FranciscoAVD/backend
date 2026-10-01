import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq } from "drizzle-orm";

/**
 * @description Update query for purchase with a matching Stripe payment intent ID. Used by refund and
 * dispute webhooks, which only know the payment intent. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of a non-null Stripe payment intent ID
 * @param update object of updated fields enforced by Payment.Purchase.Update
 * @returns Object containing the updated purchase's ID, or null. If null, no purchase uses that payment intent.
 */
export async function updatePurchaseByPaymentIntent(
  purchase: { stripePaymentIntentId: string },
  update: Payment.Purchase.Update,
): Promise<Pick<Payment.Purchase, "id"> | null> {
  const res = await db
    .update(purchaseTable)
    .set(update)
    .where(
      eq(purchaseTable.stripePaymentIntentId, purchase.stripePaymentIntentId),
    )
    .returning({ id: purchaseTable.id });
  return res[0] ?? null;
}
