/**
 * @description Makes purchases match Stripe for recent one-time checkouts: records paid
 * checkouts whose webhook never landed (e.g. Stripe gave up retrying during a DB outage)
 * and syncs refund/dispute state. Safe to run repeatedly. Importable so the counting logic
 * below is covered by `reconcile.test.ts` - `scripts/reconcile.ts` is just its thin CLI wrapper.
 */
import type Stripe from "stripe";
import { getPaymentProcessor } from "@f/payments/payment";
import { confirmCheckout } from "@f/payments/lib/webhook";
import { resolveChargeState, type PurchaseState } from "@f/payments/lib/charge-state";
import { paymentsRepo } from "@f/payments/repo";
import type { Subscription } from "@f/payments/use-cases/get-subscription";
import type { SubscriptionCorrection } from "@f/payments/use-cases/update-subscription";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

export type ReconcileSummary = {
  scanned: number;
  inserted: number;
  updated: number;
  failed: number;
};

type ReconcileResult = { inserted: boolean; updated: boolean };

/**
 * @description Reconciles one Checkout Session. `inserted`/`updated` on the returned result
 * reflect what actually happened - in particular, `inserted` is only ever true once `confirmCheckout`
 * has resolved (or, in a dry run, would have been attempted); if `confirmCheckout` throws (e.g. the
 * owner can't be resolved, or the plan was deleted), that exception propagates out of this function
 * entirely, so a caller's `tryCatch` sees a failure instead of this silently counting as an insert.
 */
export async function reconcile(
  session: Stripe.Checkout.Session,
  dryRun: boolean,
): Promise<ReconcileResult> {
  const userId = session.metadata?.userId;
  if (!userId) throw new Error("Checkout session has no userId metadata");

  const existing = await paymentsRepo.purchase.getBySession({
    userId,
    stripeCheckoutSessionId: session.id,
  });

  let current: PurchaseState | null = existing;
  let inserted = false;
  if (!existing) {
    if (dryRun) {
      logger.info({ session: session.id, dryRun }, "payments.reconcile.would_insert");
    } else {
      await confirmCheckout(session);
      logger.info({ session: session.id }, "payments.reconcile.insert");
    }
    inserted = true;
    // a freshly recorded (or, in a dry run, hypothetically recorded) purchase starts out paid
    // with nothing refunded
    current = { status: "paid", amountRefunded: 0 };
  }

  const intent = session.payment_intent as Stripe.PaymentIntent | null;
  const target = intent ? await resolveChargeState(intent.id, intent) : null;
  if (
    !intent ||
    !target ||
    (current?.status === target.status &&
      current.amountRefunded === target.amountRefunded)
  )
    return { inserted, updated: false };

  logger.info(
    { session: session.id, from: current, to: target, dryRun },
    "payments.reconcile.update",
  );
  if (!dryRun)
    await paymentsRepo.purchase.updateByPaymentIntent(
      { stripePaymentIntentId: intent.id },
      target,
    );
  return { inserted, updated: true };
}

export async function run(
  days: number,
  dryRun: boolean,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { scanned: 0, inserted: 0, updated: 0, failed: 0 };
  const stripe = getPaymentProcessor();
  const sessions = stripe.checkout.sessions.list({
    status: "complete",
    created: { gte: Math.floor(Date.now() / 1000) - days * 24 * 60 * 60 },
    expand: ["data.payment_intent.latest_charge"],
    limit: 100,
  });

  for await (const session of sessions) {
    // one-time checkouts from createCheckout only; subscriptions belong to the stripe plugin,
    // and unpaid ones are still settling (async_payment_succeeded will record them)
    if (
      session.mode !== "payment" ||
      session.payment_status === "unpaid" ||
      !session.metadata?.planId
    )
      continue;

    summary.scanned++;
    const [result, error] = await tryCatch(reconcile(session, dryRun));
    if (error) {
      summary.failed++;
      logger.error({ err: error, session: session.id }, "payments.reconcile");
      continue;
    }
    if (result.inserted) summary.inserted++;
    if (result.updated) summary.updated++;
  }
  return summary;
}

export type SubscriptionReconcileSummary = {
  checked: number;
  updated: number;
  failed: number;
};

// mirrors exactly the field set + sources @better-auth/stripe's own webhook handlers
// (onSubscriptionUpdated/onSubscriptionDeleted) write on a real update - periodStart/periodEnd
// come from the first subscription item, not the subscription object itself, since Stripe moved
// period fields to the item level
function subscriptionFieldsFromStripe(sub: Stripe.Subscription): SubscriptionCorrection {
  const item = sub.items.data[0];
  return {
    status: sub.status,
    periodStart: item ? new Date(item.current_period_start * 1000) : null,
    periodEnd: item ? new Date(item.current_period_end * 1000) : null,
    trialStart: sub.trial_start ? new Date(sub.trial_start * 1000) : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : null,
  };
}

const sameInstant = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

// two Date instances for the same instant are never === , so dates need their own comparison
function subscriptionFieldsDiffer(
  stored: Subscription,
  target: SubscriptionCorrection,
): boolean {
  return (
    stored.status !== target.status ||
    stored.cancelAtPeriodEnd !== target.cancelAtPeriodEnd ||
    !sameInstant(stored.periodStart, target.periodStart ?? null) ||
    !sameInstant(stored.periodEnd, target.periodEnd ?? null) ||
    !sameInstant(stored.trialStart, target.trialStart ?? null) ||
    !sameInstant(stored.trialEnd, target.trialEnd ?? null) ||
    !sameInstant(stored.cancelAt, target.cancelAt ?? null) ||
    !sameInstant(stored.canceledAt, target.canceledAt ?? null) ||
    !sameInstant(stored.endedAt, target.endedAt ?? null)
  );
}

/**
 * @description Re-checks one subscription row against Stripe's current state, correcting it if
 * anything differs - the backstop for an out-of-order or retried webhook event that overwrote a
 * newer status. Never touches identity fields (plan, referenceId, stripeCustomerId,
 * stripeSubscriptionId itself) - only what `updateSubscriptionFields` accepts. Operation must be
 * wrapped in try-catch
 */
export async function reconcileSubscription(
  row: Subscription,
  dryRun: boolean,
): Promise<{ updated: boolean }> {
  if (!row.stripeSubscriptionId) return { updated: false };

  const current = await getPaymentProcessor().subscriptions.retrieve(row.stripeSubscriptionId);
  const target = subscriptionFieldsFromStripe(current);

  if (!subscriptionFieldsDiffer(row, target)) return { updated: false };

  logger.info(
    { subscription: row.stripeSubscriptionId, from: row, to: target, dryRun },
    "payments.reconcile.subscription_update",
  );
  if (!dryRun)
    await paymentsRepo.subscription.updateFields(
      { stripeSubscriptionId: row.stripeSubscriptionId },
      target,
    );
  return { updated: true };
}

/**
 * @description Second, independent reconciler pass: corrects subscription rows whose status has
 * drifted from Stripe's own, one `subscriptions.retrieve` per row - scoped to rows not already in
 * a terminal state (`getReconcilableSubscriptions`), so call volume is bounded by currently
 * live-ish subscriber count re-checked once per scheduled run, not by webhook traffic the way a
 * per-event Stripe call would be.
 */
export async function runSubscriptions(
  dryRun: boolean,
): Promise<SubscriptionReconcileSummary> {
  const summary: SubscriptionReconcileSummary = { checked: 0, updated: 0, failed: 0 };
  const rows = await paymentsRepo.subscription.getReconcilable();

  for (const row of rows) {
    if (!row.stripeSubscriptionId) continue;

    summary.checked++;
    const [result, error] = await tryCatch(reconcileSubscription(row, dryRun));
    if (error) {
      summary.failed++;
      logger.error(
        { err: error, subscription: row.stripeSubscriptionId },
        "payments.reconcile.subscription",
      );
      continue;
    }
    if (result.updated) summary.updated++;
  }
  return summary;
}
