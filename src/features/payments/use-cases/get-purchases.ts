import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq, and } from "drizzle-orm";

/**
 * @description Select query for all purchases with a matching user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of user ID enforced by Pick<Payment.Purchase, "userID">
 * @returns Array of Purchases.
 */
export async function getAllPurchases(
  purchase: Pick<Payment.Purchase, "userID">,
): Promise<Payment.Purchase[]> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(eq(purchaseTable.userID, purchase.userID));
  return res;
}

/**
 * @description Select query for purchase with a matching checkout session ID and user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of session ID and user ID enforced by Pick<Payment.Purchase, "userID" | "stripeCheckoutSessionId">
 * @returns Purchase object or null. If null, the checkout hasn't been confirmed (or isn't this user's).
 */
export async function getPurchaseBySession(
  purchase: Pick<Payment.Purchase, "userID" | "stripeCheckoutSessionId">,
): Promise<Payment.Purchase | null> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(
      and(
        eq(
          purchaseTable.stripeCheckoutSessionId,
          purchase.stripeCheckoutSessionId,
        ),
        eq(purchaseTable.userID, purchase.userID),
      ),
    );
  return res[0] ?? null;
}
