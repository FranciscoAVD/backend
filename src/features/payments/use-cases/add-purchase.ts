import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { isForeignKeyViolation } from "@f/payments/lib/utils";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @description Idempotent insert query for a confirmed purchase. A purchase already recorded for the
 * same checkout session is left untouched, so webhook retries are safe. `expiresAt`/`durationDays` are
 * snapshotted from the plan at `purchasedAt` (when Stripe recorded the payment as succeeded, not insert
 * time - so a purchase recorded late by the reconciler doesn't get bonus days, and one paid by a
 * delayed method that took days to settle doesn't lose them), independent of any other
 * purchase of the same plan (purchases of a plan can overlap). If the user was deleted between checkout
 * and this insert, the resulting foreign-key violation is caught and retried with `userId: null` - the
 * purchase is still a real financial record and must never be dropped just because its owner is gone.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param user object of the purchasing user's own (always real, live at checkout time) user ID
 * @param purchase object of insert fields enforced by Payment.Purchase.Insert
 * @param plan object of the purchased plan's duration, enforced by Pick<Payment.Plan, "durationDays">
 * @param purchasedAt the moment the payment succeeded (see `confirmCheckout`'s `paidAt`)
 * @returns Purchase object or null. If null, the purchase was already recorded.
 */
export async function addPurchase(
  user: { userId: string },
  purchase: Payment.Purchase.Insert,
  plan: Pick<Payment.Plan, "durationDays">,
  purchasedAt: Date,
): Promise<Payment.Purchase | null> {
  const expiresAt = plan.durationDays
    ? new Date(purchasedAt.getTime() + plan.durationDays * DAY_MS)
    : null;
  const values = {
    ...purchase,
    userId: user.userId,
    expiresAt,
    durationDays: plan.durationDays,
    createdAt: purchasedAt,
  };

  try {
    const res = await db
      .insert(purchaseTable)
      .values(values)
      .onConflictDoNothing({ target: purchaseTable.stripeCheckoutSessionId })
      .returning();
    return res[0] ?? null;
  } catch (error) {
    if (!isForeignKeyViolation(error, "user_id")) throw error;
    logger.warn(
      { err: error, user: user.userId, session: purchase.stripeCheckoutSessionId },
      "payments.purchase.add.user_missing",
    );
    const res = await db
      .insert(purchaseTable)
      .values({ ...values, userId: null })
      .onConflictDoNothing({ target: purchaseTable.stripeCheckoutSessionId })
      .returning();
    return res[0] ?? null;
  }
}
