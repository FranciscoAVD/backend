import { db } from "@d/connection";
import { checkout as checkoutTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
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
 * @description The user's still-open checkout for this plan, if there is one - so `POST /checkout`
 * can send a buyer who closed the Stripe tab back to the same session rather than refusing them
 * until it expires. Only an `open` row that hasn't lapsed and knows its Stripe URL is resumable: a
 * `processing` one is already paid and settling, and a `reserving` one has no session yet. Assumes
 * validation. Operation must be wrapped in try-catch
 * @param target object of the user's own user ID and the plan ID enforced by Pick<Payment.Checkout, "planId">
 * @returns The session ID and its Stripe-hosted URL, or null if there's nothing to resume.
 */
export async function getResumableCheckout(
  target: { userId: string } & Pick<Payment.Checkout, "planId">,
): Promise<{ stripeCheckoutSessionId: string; url: string } | null> {
  const res = await db
    .select({
      stripeCheckoutSessionId: checkoutTable.stripeCheckoutSessionId,
      url: checkoutTable.url,
    })
    .from(checkoutTable)
    .where(
      and(
        eq(checkoutTable.userId, target.userId),
        eq(checkoutTable.planId, target.planId),
        eq(checkoutTable.status, "open"),
        gt(checkoutTable.expiresAt, sql`now()`),
        isNotNull(checkoutTable.stripeCheckoutSessionId),
        isNotNull(checkoutTable.url),
      ),
    );

  const row = res[0];
  return row?.stripeCheckoutSessionId && row.url
    ? { stripeCheckoutSessionId: row.stripeCheckoutSessionId, url: row.url }
    : null;
}
