import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq } from "drizzle-orm";

type PurchaseState = Pick<Payment.Purchase, "status" | "amountRefunded">;

export type ChargeSyncResult =
  | { found: false }
  | { found: true; updated: boolean; from: PurchaseState; to: PurchaseState | null };

/**
 * @description Brings the purchase paid by a payment intent in line with Stripe's live refund/dispute
 * state, holding the purchase row locked (`SELECT ... FOR UPDATE`) from before the live state is
 * fetched until it's written. Without the lock, two syncs of one purchase running together (a refund
 * and a dispute event, a retry, the reconciler) could each fetch, and the one that fetched *first*
 * could write *last* - undoing a refund, say, and handing access back. With it they run one after
 * the other, and the last to write is always the last to have fetched. Holds the lock across one
 * Stripe call, which is fine at webhook volumes for a single row. Assumes validation. Operation must
 * be wrapped in try-catch
 * @param purchase object of a non-null Stripe payment intent ID
 * @param resolve fetches the live target state (`resolveChargeState`), called only once the lock is
 * held and only if there's a purchase row at all; null means there's no charge to sync from yet
 * @param options `write: false` reports what would change without changing it (a dry run)
 * @returns `found: false` if no purchase was paid by this intent; otherwise its state before, the
 * live target, and whether it changed (or, without `write`, would have).
 */
export async function syncPurchaseCharge(
  purchase: { stripePaymentIntentId: string },
  resolve: () => Promise<PurchaseState | null>,
  options: { write: boolean } = { write: true },
): Promise<ChargeSyncResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: purchaseTable.id,
        status: purchaseTable.status,
        amountRefunded: purchaseTable.amountRefunded,
      })
      .from(purchaseTable)
      .where(eq(purchaseTable.stripePaymentIntentId, purchase.stripePaymentIntentId))
      .for("update");
    if (!row) return { found: false };

    const from = { status: row.status, amountRefunded: row.amountRefunded };
    const to = await resolve();
    const updated =
      to !== null &&
      (to.status !== from.status || to.amountRefunded !== from.amountRefunded);

    if (updated && options.write)
      await tx
        .update(purchaseTable)
        .set({ status: to.status, amountRefunded: to.amountRefunded })
        .where(eq(purchaseTable.id, row.id));
    return { found: true, updated, from, to };
  });
}
