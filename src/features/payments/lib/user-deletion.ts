import { getPaymentProcessor } from "@f/payments/payment";
import {
  CANCEL_ON_USER_DELETE,
  SUBSCRIPTION_TERMINAL_STATUSES,
} from "@f/payments/lib/access-policy";
import { logger } from "@/lib/logger";
import { APIError } from "better-auth/api";
import type Stripe from "stripe";
import { PROCESSING_TTL_SEC } from "@f/payments/lib/pending-checkout";

type DeletedUser = { id: string; stripeCustomerId?: string | null };

const isTerminal = (status: string) =>
  (SUBSCRIPTION_TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * @description Cancels every live Stripe subscription a user has, before the user is deleted.
 * Wired to better-auth's `databaseHooks.user.delete.before` in `auth.ts`, which every deletion
 * path goes through (the admin plugin's `removeUser` and the self-service `/delete-user` alike).
 * Without it, a deleted user keeps being billed: neither `@better-auth/stripe` nor anything else
 * here cancels a user's subscriptions on deletion.
 *
 * Lists subscriptions from Stripe by customer rather than reading the `subscription` table, so a
 * subscription whose row is missing or stale is still cancelled. The Stripe customer itself is
 * kept, not deleted: its payment history is still needed for refunds and disputes, the same reason
 * `purchase` rows outlive their user. Cancellation terms come from `CANCEL_ON_USER_DELETE`.
 *
 * Fails closed: if any cancellation fails, this throws and better-auth aborts the deletion, so a
 * user is never deleted while still being billed. Retrying the deletion is safe - subscriptions
 * already cancelled are skipped.
 * @param user the user row about to be deleted (better-auth passes the full row, including the
 * stripe plugin's `stripeCustomerId` field)
 * @returns the ids of the subscriptions it cancelled.
 */
export async function cancelSubscriptionsForDeletedUser(
  user: DeletedUser,
): Promise<string[]> {
  if (!user.stripeCustomerId) return [];

  const stripe = getPaymentProcessor();
  const cancelled: string[] = [];
  // `status: "all"`, not the default: the default omits canceled ones (fine), but listing every
  // status keeps this independent of which non-terminal statuses Stripe's default includes
  for await (const subscription of stripe.subscriptions.list({
    customer: user.stripeCustomerId,
    status: "all",
    limit: 100,
  })) {
    if (isTerminal(subscription.status)) continue;
    try {
      await stripe.subscriptions.cancel(subscription.id, CANCEL_ON_USER_DELETE);
      cancelled.push(subscription.id);
    } catch (error) {
      logger.error(
        { err: error, user: user.id, subscription: subscription.id },
        "payments.user_delete.cancel_subscription",
      );
      throw error;
    }
  }

  if (cancelled.length)
    logger.info(
      { user: user.id, subscriptions: cancelled },
      "payments.user_delete.cancelled_subscriptions",
    );
  return cancelled;
}

/**
 * @description Expires every open Checkout Session a user has, before the user is deleted - both this
 * feature's one-time checkouts and the stripe plugin's subscription ones. Otherwise a tab left open
 * at deletion time could still be paid: a one-time purchase would be recorded with no owner, and a
 * subscription checkout would start billing a user who no longer exists. Runs before
 * `cancelSubscriptionsForDeletedUser`, so no new subscription can appear after that lists them.
 *
 * Fails closed, the same as cancellation: if an expiry fails (including a session the user completed
 * at that very moment), this throws and better-auth aborts the deletion. Retrying is safe - an
 * already-expired or completed session is no longer listed as open.
 * @param user the user row about to be deleted
 * @returns the ids of the sessions it expired.
 */
export async function expireCheckoutsForDeletedUser(user: DeletedUser): Promise<string[]> {
  if (!user.stripeCustomerId) return [];

  const stripe = getPaymentProcessor();
  const expired: string[] = [];
  for await (const session of stripe.checkout.sessions.list({
    customer: user.stripeCustomerId,
    status: "open",
    limit: 100,
  })) {
    try {
      await stripe.checkout.sessions.expire(session.id);
      expired.push(session.id);
    } catch (error) {
      logger.error(
        { err: error, user: user.id, session: session.id },
        "payments.user_delete.expire_checkout",
      );
      throw error;
    }
  }

  if (expired.length)
    logger.info({ user: user.id, sessions: expired }, "payments.user_delete.expired_checkouts");
  return expired;
}

/**
 * Thrown (as better-auth's APIError, so the deletion request answers 409 instead of 500) when the
 * user still has a one-time payment settling.
 */
export const paymentSettlingError = () =>
  new APIError("CONFLICT", {
    message: "A payment on this account is still settling. Try again once it has completed.",
    code: "PAYMENT_SETTLING",
  });

/**
 * @description Refuses a user's deletion while one of their one-time payments is still settling (a
 * delayed method such as a bank debit: the Checkout Session is `complete` but its payment intent is
 * still `processing`). `expireCheckoutsForDeletedUser` can't stop these - the session is no longer
 * open, and Stripe can't cancel a processing payment intent - so without this the money would
 * still move days after the account was gone, recorded as a purchase with no owner that nobody can
 * use. Run after the expiry pass, so a session that completed while that pass ran is seen here.
 *
 * Fails closed, like the other deletion passes: a Stripe error aborts the deletion. Only looks back
 * `PROCESSING_TTL_SEC`, the longest a delayed payment is tracked as settling anywhere else.
 * @param user the user row about to be deleted
 * @throws APIError (409) if a payment is still settling
 */
export async function assertNoSettlingPayments(user: DeletedUser): Promise<void> {
  if (!user.stripeCustomerId) return;

  const stripe = getPaymentProcessor();
  for await (const session of stripe.checkout.sessions.list({
    customer: user.stripeCustomerId,
    status: "complete",
    created: { gte: Math.floor(Date.now() / 1000) - PROCESSING_TTL_SEC },
    expand: ["data.payment_intent"],
    limit: 100,
  })) {
    if (session.mode !== "payment") continue;
    const intent = session.payment_intent as Stripe.PaymentIntent | string | null;
    const status =
      typeof intent === "string"
        ? (await stripe.paymentIntents.retrieve(intent)).status
        : intent?.status;
    if (status !== "processing") continue;

    logger.warn(
      { user: user.id, session: session.id },
      "payments.user_delete.payment_settling",
    );
    throw paymentSettlingError();
  }
}
