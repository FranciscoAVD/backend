/**
 * @description Product decisions about who has access, collected in one place. Each one is a
 * reasonable default for a template, not a requirement - change the value here rather than the
 * query or handler that reads it. CONTROL_FLOW.md explains how each one is used.
 */
import type Stripe from "stripe";
import type { Payment } from "@f/payments/lib/types";

/**
 * Subscription statuses that grant access to a recurring plan. Matches `@better-auth/stripe`'s
 * own `isActiveOrTrialing`, so "has access" and "is already subscribed" agree.
 *
 * Add `"past_due"` to keep access during Stripe's retry schedule after a failed renewal (a grace
 * period) instead of losing it the moment the payment fails.
 */
export const SUBSCRIPTION_ACCESS_STATUSES = [
  "active",
  "trialing",
] as const satisfies readonly Stripe.Subscription.Status[];

/**
 * Subscription statuses that will never change again, so there's nothing left to sync or cancel.
 * Not a policy choice - Stripe guarantees these are terminal.
 */
export const SUBSCRIPTION_TERMINAL_STATUSES = [
  "canceled",
  "incomplete_expired",
] as const satisfies readonly Stripe.Subscription.Status[];

/**
 * Purchase statuses that grant access to a one-time plan. `disputed` is left out: access pauses
 * while a chargeback is open and comes back if the dispute is won. Add `"disputed"` to keep access
 * until the dispute is actually lost.
 */
export const PURCHASE_ACCESS_STATUSES = [
  "paid",
] as const satisfies readonly Payment.Purchase["status"][];

/**
 * Purchase statuses that stop the same user buying a non-repeatable plan again. `disputed` counts,
 * since the money may still be kept; only `refunded` frees the slot.
 */
export const PURCHASE_BLOCKING_STATUSES = [
  "paid",
  "disputed",
] as const satisfies readonly Payment.Purchase["status"][];

/**
 * Whether a partial refund ends access. `false` keeps the purchase `paid` (and its access) until the
 * charge is fully refunded - typical for goodwill credits. `true` treats any refund as revoking it.
 */
export const PARTIAL_REFUND_REVOKES_ACCESS = false;

/**
 * Whether someone who still holds access to a plan that has since been deactivated keeps it.
 * `true` honors what they paid for: a retired subscription keeps working until it ends, and a
 * retired one-time plan keeps its remaining window. Deactivating only stops new purchases.
 */
export const RETIRED_PLANS_KEEP_ACCESS = true;

/**
 * How a user's live subscriptions are cancelled when the user is deleted. Without this, deleting a
 * user would leave Stripe billing them indefinitely. The default ends the subscription now, with
 * no refund for the unused part of the period and no final invoice for pending usage.
 * Set `prorate: true` to credit the unused time instead.
 */
export const CANCEL_ON_USER_DELETE: Stripe.SubscriptionCancelParams = {
  prorate: false,
  invoice_now: false,
};
