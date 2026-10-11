import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq, and } from "drizzle-orm";

/**
 * @description Select query for all purchases with a matching user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of the caller's own user ID - always a real, live user, unlike a purchase
 * row's own (nullable) userId once that user is deleted
 * @returns Array of Purchases.
 */
export async function getAllPurchases(
  purchase: { userId: string },
): Promise<Payment.Purchase[]> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(eq(purchaseTable.userId, purchase.userId));
  return res;
}

/**
 * @description Select query for purchase with a matching checkout session ID and user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of session ID (enforced by Pick<Payment.Purchase, "stripeCheckoutSessionId">)
 * and the caller's own user ID - always a real, live user, unlike a purchase row's own (nullable)
 * userId once that user is deleted
 * @returns Purchase object or null. If null, the checkout hasn't been confirmed (or isn't this user's).
 */
export async function getPurchaseBySession(
  purchase: { userId: string } & Pick<Payment.Purchase, "stripeCheckoutSessionId">,
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
        eq(purchaseTable.userId, purchase.userId),
      ),
    );
  return res[0] ?? null;
}
