import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { and, eq } from "drizzle-orm";

type PurchaseState = Pick<Payment.Purchase, "status" | "amountRefunded">;

export type ChargeSyncResult =
  | { found: false }
  | {
      found: true;
      updated: boolean;
      from: PurchaseState;
      to: PurchaseState | null;
      purchase: Pick<Payment.Purchase, "userId" | "planId" | "currency">;
    };

// a write that keeps losing to concurrent ones gives up rather than spinning: the caller fails (the
// webhook answers 400 and Stripe redelivers; the reconciler counts it failed) and tries later
const MAX_ATTEMPTS = 3;

/**
 * @description Brings the purchase paid by a payment intent in line with Stripe's live refund/dispute
 * state, as a compare-and-set: the row is read, the live state fetched, and the write only lands if
 * the row still holds what was read. Two syncs of one purchase running together (a refund and a
 * dispute event, a retry, the reconciler) can each fetch, and the one that fetched *first* could
 * otherwise write *last* - undoing a refund, say, and handing access back. Here that write finds the
 * row changed, so it re-reads and re-fetches instead, and the last write always reflects a fetch made
 * after the previous one landed.
 *
 * Deliberately not a row lock held across the fetch: that kept a database connection checked out for
 * as long as Stripe took to answer (its client allows 80s, plus retries), so a burst of these during a
 * Stripe slowdown could take the whole pool and stall every other request in the app. Assumes
 * validation. Operation must be wrapped in try-catch
 * @param purchase object of a non-null Stripe payment intent ID
 * @param resolve fetches the live target state (`resolveChargeState`), called only if there's a
 * purchase row at all, and again after each lost race; null means there's no charge to sync from yet
 * @param options `write: false` reports what would change without changing it (a dry run)
 * @returns `found: false` if no purchase was paid by this intent; otherwise its state before, the
 * live target, whether it changed (or, without `write`, would have), and the purchase's owner/plan/
 * currency - for a caller (e.g. a refund-confirmation email) that needs to act on the transition
 * without a second lookup.
 */
export async function syncPurchaseCharge(
  purchase: { stripePaymentIntentId: string },
  resolve: () => Promise<PurchaseState | null>,
  options: { write: boolean } = { write: true },
): Promise<ChargeSyncResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [row] = await db
      .select({
        id: purchaseTable.id,
        status: purchaseTable.status,
        amountRefunded: purchaseTable.amountRefunded,
        userId: purchaseTable.userId,
        planId: purchaseTable.planId,
        currency: purchaseTable.currency,
      })
      .from(purchaseTable)
      .where(eq(purchaseTable.stripePaymentIntentId, purchase.stripePaymentIntentId));
    if (!row) return { found: false };

    const owner = { userId: row.userId, planId: row.planId, currency: row.currency };
    const from = { status: row.status, amountRefunded: row.amountRefunded };
    const to = await resolve();
    const differs =
      to !== null &&
      (to.status !== from.status || to.amountRefunded !== from.amountRefunded);
    if (!differs || !options.write)
      return { found: true, updated: differs, from, to, purchase: owner };

    const written = await db
      .update(purchaseTable)
      .set({ status: to.status, amountRefunded: to.amountRefunded })
      .where(
        and(
          eq(purchaseTable.id, row.id),
          eq(purchaseTable.status, from.status),
          eq(purchaseTable.amountRefunded, from.amountRefunded),
        ),
      )
      .returning({ id: purchaseTable.id });
    if (written.length > 0) return { found: true, updated: true, from, to, purchase: owner };
    // the row changed since it was read - this fetch may predate that change, so start over
  }
  throw new Error("Purchase kept changing during its charge sync; retry later");
}
