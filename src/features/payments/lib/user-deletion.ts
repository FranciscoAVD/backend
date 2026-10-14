import { getPaymentProcessor } from "@f/payments/payment";
import {
  CANCEL_ON_USER_DELETE,
  SUBSCRIPTION_TERMINAL_STATUSES,
} from "@f/payments/lib/access-policy";
import { logger } from "@/lib/logger";

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
