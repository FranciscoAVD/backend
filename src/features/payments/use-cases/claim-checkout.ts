import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import {
  CHECKOUT_ACTIVE_STATUSES,
  CHECKOUT_EXPIRY_CLOCK_SKEW_SEC,
  CHECKOUT_SESSION_EXPIRY_MARGIN_SEC,
} from "@f/payments/lib/constants";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

// an `open` row's session is dead CHECKOUT_SESSION_EXPIRY_MARGIN_SEC before the row's own
// expiresAt; it's swept from then, plus clock-skew slack so a session Stripe still accepts never
// loses its slot to a second checkout
const OPEN_SWEEP_LEAD_SEC = CHECKOUT_SESSION_EXPIRY_MARGIN_SEC - CHECKOUT_EXPIRY_CLOCK_SKEW_SEC;

/**
 * The only slot a checkout ever holds. A second one would mean letting a user buy the same
 * non-repeatable plan twice at once, which is exactly what the slot exists to prevent - it's a
 * column rather than a flag so a repeatable plan's row can *release* it (to null, which never
 * collides in the unique index) once its session is open.
 */
const SLOT = 1;

/**
 * Marks a (user, plan)'s slot-holding rows `expired` once they're stale - the request died
 * mid-checkout, or Stripe's `checkout.session.expired` webhook never landed. Without this a stuck
 * row would hold the slot forever. A `reserving` or `processing` row is stale past its own
 * `expiresAt`; an `open` one as soon as its Stripe session has expired (see `OPEN_SWEEP_LEAD_SEC`),
 * rather than locking the buyer out for the row's last minutes behind a session nobody can pay.
 * Private to the claim below, which is the only path that needs the slot free.
 */
async function expireStaleCheckouts(
  target: { userId: string } & Pick<Payment.Checkout, "planId">,
): Promise<void> {
  await db
    .update(checkoutTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(checkoutTable.userId, target.userId),
        eq(checkoutTable.planId, target.planId),
        eq(checkoutTable.slot, SLOT),
        inArray(checkoutTable.status, CHECKOUT_ACTIVE_STATUSES),
        or(
          lt(checkoutTable.expiresAt, sql`now()`),
          and(
            eq(checkoutTable.status, "open"),
            lt(
              checkoutTable.expiresAt,
              sql`now() + make_interval(secs => ${OPEN_SWEEP_LEAD_SEC})`,
            ),
          ),
        ),
      ),
    );
}

/**
 * @description Atomically claims the (user, plan) slot for a checkout that's about to be created,
 * so two concurrent `POST /checkout` requests can't both reach Stripe. Stale rows for the slot are
 * swept first (see `expireStaleCheckouts`) and then the insert itself is the gate: the
 * `checkout_active_slot` partial unique index lets exactly one of any number of concurrent inserts
 * through. The returned row's own `id` is the reservation - `openCheckout` only ever opens a row
 * still `reserving` under that id, so a reservation swept and replaced in the meantime can't be
 * opened by the request that lost it. Assumes validation. Operation must be wrapped in try-catch
 * @param user object of the claiming user's own (always real, live) user ID
 * @param data object of insert fields enforced by Payment.Checkout.Insert
 * @returns Checkout object or null. If null, an active checkout already holds the slot.
 */
export async function claimCheckoutSlot(
  user: { userId: string },
  data: Payment.Checkout.Insert,
): Promise<Payment.Checkout | null> {
  await expireStaleCheckouts({ userId: user.userId, planId: data.planId });

  const res = await db
    .insert(checkoutTable)
    .values({ ...data, userId: user.userId, status: "reserving", slot: SLOT })
    .onConflictDoNothing({
      target: [checkoutTable.userId, checkoutTable.planId, checkoutTable.slot],
      // an ON CONFLICT against a partial index has to repeat the index's own predicate for
      // Postgres to infer it - keep this identical to `checkout_active_slot`'s
      where: sql`status in ('reserving', 'open', 'processing')`,
    })
    .returning();
  return res[0] ?? null;
}
