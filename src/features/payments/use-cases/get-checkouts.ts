import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { CHECKOUT_SESSION_EXPIRY_MARGIN_SEC } from "@f/payments/lib/constants";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";

/**
 * @description Select query for the checkout a Stripe Checkout Session belongs to. Not scoped to a
 * user: the webhook and the reconciler both resolve a session they were handed by Stripe, and
 * `services.checkout.status` does its own `userId` check on the row it gets back. Assumes
 * validation. Operation must be wrapped in try-catch
 * @param target object of the Stripe session ID - a real one, unlike the column itself, which is
 * null only for a row still `reserving`
 * @returns Checkout object or null. If null, no checkout was ever recorded for that session.
 */
export async function getCheckoutBySession(
  target: { stripeCheckoutSessionId: string },
): Promise<Payment.Checkout | null> {
  const res = await db
    .select()
    .from(checkoutTable)
    .where(
      eq(checkoutTable.stripeCheckoutSessionId, target.stripeCheckoutSessionId),
    );
  return res[0] ?? null;
}

/**
 * @description The user's still-open checkout for this plan, if its Stripe session is still alive -
 * so `POST /checkout` can send a buyer who closed the Stripe tab back to the same session rather
 * than refusing them until it expires. The session expires `CHECKOUT_SESSION_EXPIRY_MARGIN_SEC`
 * before the row's own `expiresAt`, so that's the cutoff, not the row's deadline. The row's
 * `expiresAt` comes back too: whether a session with only a few minutes left is worth handing
 * back, or should be replaced, is `services.checkout.start`'s call. A `processing` row is already
 * paid and settling, and a `reserving` one has no session yet; a row with no url can't be resumed.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the user's own user ID and the plan ID enforced by Pick<Payment.Checkout, "planId">
 * @returns The session ID, its Stripe-hosted URL and the row's deadline, or null if there's nothing
 * alive to resume.
 */
export async function getResumableCheckout(
  target: { userId: string } & Pick<Payment.Checkout, "planId">,
): Promise<{ stripeCheckoutSessionId: string; url: string; expiresAt: Date } | null> {
  const res = await db
    .select({
      stripeCheckoutSessionId: checkoutTable.stripeCheckoutSessionId,
      url: checkoutTable.url,
      expiresAt: checkoutTable.expiresAt,
    })
    .from(checkoutTable)
    .where(
      and(
        eq(checkoutTable.userId, target.userId),
        eq(checkoutTable.planId, target.planId),
        eq(checkoutTable.status, "open"),
        gt(
          checkoutTable.expiresAt,
          sql`now() + make_interval(secs => ${CHECKOUT_SESSION_EXPIRY_MARGIN_SEC})`,
        ),
        isNotNull(checkoutTable.stripeCheckoutSessionId),
        isNotNull(checkoutTable.url),
      ),
    );

  const row = res[0];
  return row?.stripeCheckoutSessionId && row.url
    ? { stripeCheckoutSessionId: row.stripeCheckoutSessionId, url: row.url, expiresAt: row.expiresAt }
    : null;
}
