import { paymentsRepo } from "@f/payments/repo";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import {
  isUserDeleting,
  markUserDeleting,
  clearUserDeleting,
} from "@f/payments/lib/state/deletion-guard";
import { PROCESSING_TTL_SEC } from "@f/payments/lib/constants";
import {
  CANCEL_ON_USER_DELETE,
  SUBSCRIPTION_TERMINAL_STATUSES,
} from "@f/payments/lib/access-policy";
import { APIError } from "better-auth/api";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import type Stripe from "stripe";

type Customer = { id: string; name: string; email: string };
type DeletedUser = { id: string; stripeCustomerId?: string | null };

/**
 * @description The idempotency key for creating this user's customer: the user id plus a hash of
 * the parameters sent. Stripe rejects a key reused with different parameters for 24h, so a key of
 * the user id alone made checkout fail for a day for anyone who changed their name or email after a
 * creation attempt that didn't get saved. A retry with the same details still reuses the key.
 */
export function customerIdempotencyKey(user: Customer): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([user.email, user.name]))
    .digest("hex")
    .slice(0, 16);
  return `customer-${user.id}-${digest}`;
}

/**
 * @description Returns the user's Stripe customer id, creating one first if `createCustomerOnSignUp`'s
 * sign-up hook never succeeded (e.g. Stripe was unreachable at sign-up time). Always re-reads the
 * live `user` row itself rather than trusting a caller-supplied value - better-auth can serve a
 * Redis-cached `user` object without querying Postgres. A deterministic idempotency key protects a
 * retried call (e.g. after a timeout) from creating a second customer; it does not fully close two
 * truly simultaneous requests racing each other, which Stripe's idempotency semantics don't strictly
 * guarantee to dedupe - acceptable for now given how narrow that window is. The key also covers
 * the name and email sent (see `customerIdempotencyKey`). Mirrors the metadata
 * shape the stripe plugin itself sets, so a customer created here looks the same either way.
 *
 * The new id is written through better-auth's own `internalAdapter.updateUser`, not
 * `paymentsRepo.user.setStripeCustomerId`, because that also refreshes the user's cached sessions.
 * The stripe plugin's subscription flow reads `stripeCustomerId` from the session: written behind
 * its back, the session kept serving `null`, and the plugin then created a second customer and
 * switched the user over to it, splitting their payment history across two Stripe customers.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param user object of id, name and email
 * @returns The existing or newly created Stripe customer id.
 */
export async function ensureCustomer(user: Customer): Promise<string> {
  const row = await paymentsRepo.user.getForCustomer({ userId: user.id });
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await getPaymentProcessor().customers.create(
    {
      email: user.email,
      name: user.name,
      metadata: { userId: user.id, customerType: "user" },
    },
    { idempotencyKey: customerIdempotencyKey(user) },
  );

  // imported here, not at the top: auth.ts itself imports this feature's services
  const { auth } = await import("@f/auth/auth");
  await (await auth.$context).internalAdapter.updateUser(user.id, {
    stripeCustomerId: customer.id,
  });

  return customer.id;
}

/**
 * @description Cancels every live Stripe subscription a user has, before the user is deleted.
 * Lists subscriptions from Stripe by customer rather than reading the `subscription` table, so a
 * subscription whose row is missing or stale is still cancelled. The Stripe customer itself is
 * kept, not deleted. Fails closed: if any cancellation fails, this throws.
 * @returns the ids of the subscriptions it cancelled.
 */
export async function cancelSubscriptionsForDeletedUser(
  user: DeletedUser,
): Promise<string[]> {
  if (!user.stripeCustomerId) return [];

  const stripe = getPaymentProcessor();
  const cancelled: string[] = [];
  const isTerminal = (status: string) =>
    (SUBSCRIPTION_TERMINAL_STATUSES as readonly string[]).includes(status);
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
 * @description Expires every open Checkout Session a user has, before the user is deleted - both
 * this feature's one-time checkouts and the stripe plugin's subscription ones. Fails closed.
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
 * still `processing`). Fails closed. Only looks back `PROCESSING_TTL_SEC`.
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

/**
 * @description The `user.delete.before` hook body (wired in `features/auth/auth.ts`): refuses the
 * deletion up front if a payment is already settling, raises the deletion flag, expires open
 * checkouts, checks for a settling payment again, then cancels subscriptions - in that exact order;
 * see CONTROL_FLOW.md's "Deleting a user" for why each step depends on the one before it.
 *
 * The settling check runs twice on purpose. The first, before anything is touched, makes the
 * common refusal side-effect free: without it, a user told "a payment is still settling, try
 * again later" had already lost every checkout they had open. The second, after the expiry pass,
 * is the one that closes the race: a checkout paid after the first check listed sessions, but
 * before the expiry pass did, is no longer `open` for that pass to expire - only this catches it.
 */
export async function prepareDeletion(user: DeletedUser): Promise<void> {
  await assertNoSettlingPayments(user);
  await markUserDeleting(user.id);
  await expireCheckoutsForDeletedUser(user);
  await assertNoSettlingPayments(user);
  await cancelSubscriptionsForDeletedUser(user);
}

/** @description Clears the deletion flag raised by `prepareDeletion`, for an aborted deletion. */
export async function abortDeletion(userId: string): Promise<void> {
  await clearUserDeleting(userId);
}

/**
 * @description Re-checks the deletion flag once `/subscription/upgrade` has created its Checkout
 * Session: if the user's deletion started in the meantime, their open sessions are expired and the
 * caller (`lib/auth-hooks.ts`'s `paymentsAfterHook`) throws instead of handing back a payable URL.
 * @returns whether the request should be blocked.
 */
export async function guardSubscriptionUpgrade(userId: string): Promise<{ blocked: boolean }> {
  const [deleting, flagError] = await tryCatch(isUserDeleting(userId));
  // a Redis failure here almost certainly failed the deletion hook's own flag write too, which
  // aborts the deletion - so let the checkout through rather than failing a normal purchase
  if (flagError) {
    logger.warn({ err: flagError, user: userId }, "payments.deletion_guard.check");
    return { blocked: false };
  }
  if (!deleting) return { blocked: false };

  const row = await paymentsRepo.user.getForCustomer({ userId });
  const [, expireError] = await tryCatch(
    expireCheckoutsForDeletedUser({ id: userId, stripeCustomerId: row?.stripeCustomerId }),
  );
  if (expireError)
    logger.error(
      { err: expireError, user: userId },
      "payments.deletion_guard.expire_subscription_checkout",
    );
  return { blocked: true };
}
