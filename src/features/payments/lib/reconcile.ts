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
  paidAt?: Date,
): Promise<ReconcileResult> {
  const userId = session.metadata?.userId;
  if (!userId) throw new Error("Checkout session has no userId metadata");

  // not scoped to the metadata's userId: a purchase whose user was since deleted has userId
  // null, and a user-scoped lookup would miss it and re-"insert" it on every run
  const existing = await paymentsRepo.purchase.getBySessionAnyUser({
    stripeCheckoutSessionId: session.id,
  });

  let current: PurchaseState | null = existing;
  let inserted = false;
  if (!existing) {
    if (dryRun) {
      logger.info({ session: session.id, dryRun }, "payments.reconcile.would_insert");
      inserted = true;
    } else {
      // confirmCheckout reports what actually happened: false if the row appeared between the
      // lookup above and this insert (the webhook landed first), so that's not counted
      inserted = await confirmCheckout(session, paidAt ?? fallbackPaidAt(session));
      if (inserted) logger.info({ session: session.id }, "payments.reconcile.insert");
    }
    current = inserted
      ? // a freshly recorded (or, in a dry run, hypothetically recorded) purchase starts out
        // paid with nothing refunded
        { status: "paid", amountRefunded: 0 }
      : await paymentsRepo.purchase.getBySessionAnyUser({
          stripeCheckoutSessionId: session.id,
        });
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

// the events that mark a one-time checkout's payment as succeeded - the same two the webhook
// confirms on, so a purchase the reconciler records starts its access window exactly where the
// webhook's would have
const SUCCESS_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const satisfies readonly Stripe.Event.Type[];

/**
 * @description When each recent Checkout Session's payment succeeded, per Stripe's own events -
 * the webhook's `paidAt`, recovered for sessions whose webhook never landed. A `completed` event
 * for a still-unpaid (delayed-method) session isn't a success; its later `async_payment_succeeded`
 * is. Stripe keeps events for 30 days, comfortably longer than the default scan window.
 * @returns A map of session id to payment time.
 */
async function getSuccessTimes(sinceSec: number): Promise<Map<string, Date>> {
  const times = new Map<string, Date>();
  const events = getPaymentProcessor().events.list({
    types: [...SUCCESS_EVENTS],
    created: { gte: sinceSec },
    limit: 100,
  });
  for await (const event of events) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "payment") continue;
    if (event.type === "checkout.session.completed" && session.payment_status === "unpaid")
      continue;
    // async success always comes after its own completed event, so the latest one wins
    const at = new Date(event.created * 1000);
    const seen = times.get(session.id);
    if (!seen || at > seen) times.set(session.id, at);
  }
  return times;
}

/**
 * @description Best available payment time when no success event was found (e.g. an older scan
 * than Stripe's 30-day event retention): the charge's own creation, which for a card is the moment
 * it was paid. For a delayed method that's when it was initiated rather than settled, still no
 * earlier than the session's creation.
 */
function fallbackPaidAt(session: Stripe.Checkout.Session): Date {
  const intent = session.payment_intent as Stripe.PaymentIntent | string | null;
  const charge =
    intent && typeof intent !== "string"
      ? (intent.latest_charge as Stripe.Charge | string | null)
      : null;
  const chargedAt = charge && typeof charge !== "string" ? charge.created : undefined;
  return new Date((typeof chargedAt === "number" ? chargedAt : session.created) * 1000);
}

export async function run(
  days: number,
  dryRun: boolean,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { scanned: 0, inserted: 0, updated: 0, failed: 0 };
  const stripe = getPaymentProcessor();
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const successTimes = await getSuccessTimes(sinceSec);
  const sessions = stripe.checkout.sessions.list({
    status: "complete",
    created: { gte: sinceSec },
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
    const [result, error] = await tryCatch(
      reconcile(session, dryRun, successTimes.get(session.id)),
    );
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
    (target.plan != null && stored.plan !== target.plan) ||
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
 * @description Re-checks one subscription row against an already-fetched Stripe subscription,
 * correcting it if anything differs - the backstop for an out-of-order or retried webhook event
 * that overwrote a newer status. Also re-resolves `plan` from the subscription's current price
 * (`getPlanByPriceId`), the same way `@better-auth/stripe`'s own `resolvePlanItem` does - `plan`
 * isn't an identity field, the plugin rewrites it on every `customer.subscription.updated` too, so
 * a lost plan-change webhook (e.g. Basic -> Pro) is exactly the kind of staleness this guards
 * against. Left untouched if no configured plan currently prices at that ID, rather than guessing
 * or nulling it out - mirrors the plugin's own "no match -> no plan update" behavior. Never
 * touches `referenceId`/`stripeCustomerId`/`stripeSubscriptionId` itself - those are the only
 * genuine identity fields here. Operation must be wrapped in try-catch
 */
export async function reconcileSubscription(
  row: Subscription,
  current: Stripe.Subscription,
  dryRun: boolean,
): Promise<{ updated: boolean }> {
  const target = subscriptionFieldsFromStripe(current);

  const priceId = current.items.data[0]?.price.id;
  if (priceId) {
    const plan = await paymentsRepo.plan.getByPriceId(priceId);
    if (plan) target.plan = plan.name.toLowerCase();
  }

  if (!subscriptionFieldsDiffer(row, target)) return { updated: false };

  logger.info(
    { subscription: current.id, from: row, to: target, dryRun },
    "payments.reconcile.subscription_update",
  );
  if (!dryRun)
    await paymentsRepo.subscription.updateFields({ stripeSubscriptionId: current.id }, target);
  return { updated: true };
}

/**
 * @description Second, independent reconciler pass: corrects subscription rows whose status,
 * period or plan has drifted from Stripe's own. Bulk-lists subscriptions from Stripe
 * (`subscriptions.list`, paginated) rather than retrieving one by one - call volume scales with
 * total live subscriptions divided by 100, not with how many rows need checking, which stays
 * rate-limit-safe even as subscriber count grows. Only acts on rows not already in a terminal
 * state (`getReconcilableSubscriptions` - Stripe guarantees those never change again), matched
 * against the list by `stripeSubscriptionId`.
 *
 * Stripe's default list leaves out canceled subscriptions - and a row still `active` because its
 * `customer.subscription.deleted` webhook was lost is exactly the drift this pass most needs to
 * catch. So every reconcilable row the list didn't return is retrieved individually afterwards:
 * normally there are none, so this costs nothing in the common case, unlike listing with
 * `status: "all"`, which would page through the account's entire cancellation history on every
 * run. A row whose subscription doesn't exist in Stripe at all - a wrong/orphaned Stripe
 * subscription ID - is counted as `failed` rather than silently skipped.
 */
export async function runSubscriptions(
  dryRun: boolean,
): Promise<SubscriptionReconcileSummary> {
  const summary: SubscriptionReconcileSummary = { checked: 0, updated: 0, failed: 0 };
  const rows = await paymentsRepo.subscription.getReconcilable();

  const byStripeId = new Map<string, Subscription>();
  for (const row of rows) {
    if (row.stripeSubscriptionId) byStripeId.set(row.stripeSubscriptionId, row);
  }

  const check = async (row: Subscription, current: Stripe.Subscription) => {
    summary.checked++;
    const [result, error] = await tryCatch(reconcileSubscription(row, current, dryRun));
    if (error) {
      summary.failed++;
      logger.error({ err: error, subscription: current.id }, "payments.reconcile.subscription");
      return;
    }
    if (result.updated) summary.updated++;
  };

  const stripe = getPaymentProcessor();
  const matched = new Set<string>();
  for await (const current of stripe.subscriptions.list({ limit: 100 })) {
    const row = byStripeId.get(current.id);
    if (!row) continue;
    matched.add(current.id);
    await check(row, current);
  }

  // not in the default list: canceled since the row was last written (a lost webhook), or
  // genuinely missing from Stripe
  for (const [stripeSubscriptionId, row] of byStripeId) {
    if (matched.has(stripeSubscriptionId)) continue;
    const [current, error] = await tryCatch(stripe.subscriptions.retrieve(stripeSubscriptionId));
    if (error) {
      summary.checked++;
      summary.failed++;
      const missing = (error as { code?: string }).code === "resource_missing";
      logger.error(
        { err: error, subscription: stripeSubscriptionId },
        missing
          ? "payments.reconcile.subscription_not_found"
          : "payments.reconcile.subscription",
      );
      continue;
    }
    await check(row, current);
  }

  return summary;
}
