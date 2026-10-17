import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { and, eq, inArray } from "drizzle-orm";

/**
 * @description Turns a reserved row into a payable session: stores the Stripe session and URL,
 * moves it to `open` and sets how long it stays that way. Only ever updates a row that's still
 * `reserving` under this exact id, which is what makes the row's own id the reservation token - a
 * reservation that lapsed and was swept (its slot since claimed by a fresh row with a different
 * id) can't be opened by the request that lost it, so there's never a second payable session for a
 * plan the user may only buy once. Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the claimed row's ID enforced by Pick<Payment.Checkout, "id">
 * @param data object of the session fields enforced by Payment.Checkout.Update. Pass `slot: null`
 * to release the slot (a repeatable plan, whose session mustn't block the next purchase)
 * @returns Object containing the opened checkout's ID, or null. If null, the reservation no longer
 * held the slot and nothing was written.
 */
export async function openCheckout(
  target: Pick<Payment.Checkout, "id">,
  data: Payment.Checkout.Update,
): Promise<Pick<Payment.Checkout, "id"> | null> {
  const res = await db
    .update(checkoutTable)
    .set({ ...data, status: "open" })
    .where(
      and(eq(checkoutTable.id, target.id), eq(checkoutTable.status, "reserving")),
    )
    .returning({ id: checkoutTable.id });
  return res[0] ?? null;
}

/**
 * @description Moves a checkout to a new status, but only from one of the statuses that may
 * precede it (`CHECKOUT_TRANSITIONS_FROM`). The predecessor check and the write are one statement,
 * so two events for the same session landing together can't both read the old status and let the
 * earlier one write last - a retried or out-of-order Stripe event never moves a checkout backward
 * or resurrects a terminal one. Terminal statuses fall outside the `checkout_active_slot` index's
 * predicate, so reaching one also frees the (user, plan) slot, with nothing to clear by hand.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the Stripe session ID - a real one, unlike the column itself, which is
 * null only for a row still `reserving`
 * @param status the status to move to
 * @param options `from`, the statuses this move is allowed from, and `expiresAt` to also extend
 * how long the new status lasts (only `processing` does - a terminal row keeps its old deadline)
 * @returns Object containing the checkout's ID, or null. If null, there was no such checkout or
 * the move would have gone backward.
 */
export async function transitionCheckout(
  target: { stripeCheckoutSessionId: string },
  status: Payment.Checkout["status"],
  options: {
    from: readonly Payment.Checkout["status"][];
    expiresAt?: Date;
  },
): Promise<Pick<Payment.Checkout, "id"> | null> {
  const res = await db
    .update(checkoutTable)
    .set({ status, ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}) })
    .where(
      and(
        eq(
          checkoutTable.stripeCheckoutSessionId,
          target.stripeCheckoutSessionId,
        ),
        inArray(checkoutTable.status, options.from),
      ),
    )
    .returning({ id: checkoutTable.id });
  return res[0] ?? null;
}

/**
 * @description Frees a claim from `claimCheckoutSlot` when checkout creation failed before a
 * session was saved. Deletes rather than expires: nothing ever happened on this row, so there's no
 * trail worth keeping, and the slot is free immediately for the user's retry. A no-op if the row
 * was already opened (the happy path) or swept. Assumes validation. Operation must be wrapped in
 * try-catch
 * @param target object of the claimed row's ID enforced by Pick<Payment.Checkout, "id">
 * @returns Object containing the released checkout's ID, or null if there was nothing to release.
 */
export async function releaseCheckoutReservation(
  target: Pick<Payment.Checkout, "id">,
): Promise<Pick<Payment.Checkout, "id"> | null> {
  const res = await db
    .delete(checkoutTable)
    .where(
      and(eq(checkoutTable.id, target.id), eq(checkoutTable.status, "reserving")),
    )
    .returning({ id: checkoutTable.id });
  return res[0] ?? null;
}
