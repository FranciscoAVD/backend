/**
 * @description Makes purchases/subscriptions match Stripe: records paid checkouts whose webhook
 * never landed, syncs refund/dispute state, and corrects drifted subscription rows. Safe to run
 * repeatedly. Importable so the counting logic below is covered by `reconcile.test.ts` -
 * `scripts/reconcile.ts` is just its thin CLI wrapper.
 */
import type Stripe from "stripe";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import { confirm } from "@f/payments/services/fulfillment";
import { isOurs, markCompleted, markFailed } from "@f/payments/services/checkout";
import { resolveChargeState, type PurchaseState } from "@f/payments/lib/stripe/charge-state";
import { paymentsRepo } from "@f/payments/repo";
import type { Subscription } from "@f/payments/use-cases/get-subscription";
import type { SubscriptionCorrection } from "@f/payments/use-cases/update-subscription";
import { logger } from "@/lib/logger";
import type { ALLOWED_EVENTS } from "@f/payments/lib/constants";
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
 * reflect what actually happened - `inserted` is only ever true once `confirm` has resolved (or,
 * in a dry run, would have been attempted); if `confirm` throws, that exception propagates out of
 * this function entirely, so a caller's `tryCatch` sees a failure instead of this silently
 * counting as an insert.
 */
async function reconcileSession(
  session: Stripe.Checkout.Session,
  dryRun: boolean,
  paidAt?: Date,
): Promise<ReconcileResult> {
  const userId = session.metadata?.userId;
  if (!userId) throw new Error("Checkout session has no userId metadata");

  const existing = await paymentsRepo.purchase.get.bySessionAnyUser({
    stripeCheckoutSessionId: session.id,
  });

  let current: PurchaseState | null = existing;
  let inserted = false;
  if (!existing) {
    if (dryRun) {
      logger.info({ session: session.id, dryRun }, "payments.reconcile.would_insert");
      inserted = true;
    } else {
      inserted = await confirm(session, paidAt ?? fallbackPaidAt(session));
      if (inserted) logger.info({ session: session.id }, "payments.reconcile.insert");
    }
    current = inserted
      ? { status: "paid", amountRefunded: 0 }
      : await paymentsRepo.purchase.get.bySessionAnyUser({
          stripeCheckoutSessionId: session.id,
        });
  }

  const intent = session.payment_intent as Stripe.PaymentIntent | null;
  const target = intent ? await resolveChargeState(intent.id, intent) : null;
  if (
    !intent ||
    !target ||
    (current?.status === target.status && current.amountRefunded === target.amountRefunded)
  )
    return { inserted, updated: false };

  if (dryRun) {
    logger.info(
      { session: session.id, from: current, to: target, dryRun },
      "payments.reconcile.update",
    );
    return { inserted, updated: true };
  }
  const synced = await paymentsRepo.purchase.syncCharge(
    { stripePaymentIntentId: intent.id },
    () => resolveChargeState(intent.id),
  );
  const updated = synced.found && synced.updated;
  if (updated && synced.found)
    logger.info(
      { session: session.id, from: synced.from, to: synced.to, dryRun },
      "payments.reconcile.update",
    );
  return { inserted, updated };
}

const SUCCESS_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const satisfies readonly Stripe.Event.Type[];

/**
 * @description When each recent Checkout Session's payment succeeded, per Stripe's own events.
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
    const at = new Date(event.created * 1000);
    const seen = times.get(session.id);
    if (!seen || at > seen) times.set(session.id, at);
  }
  return times;
}

/**
 * @description Best available payment time when no success event was found: the charge's own
 * creation, no earlier than the session's own.
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

const CHARGE_EVENTS = [
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const satisfies readonly (typeof ALLOWED_EVENTS)[number][];

/**
 * @description Payment intents with a refund or dispute event since `sinceSec`, whatever the age
 * of the payment itself - chargebacks typically land long after the purchase, past the session
 * scan's window.
 */
async function getChargeEventIntents(sinceSec: number): Promise<Set<string>> {
  const intents = new Set<string>();
  const events = getPaymentProcessor().events.list({
    types: [...CHARGE_EVENTS],
    created: { gte: sinceSec },
    limit: 100,
  });
  for await (const event of events) {
    const object = event.data.object as Stripe.Charge | Stripe.Dispute | Stripe.Refund;
    const intent = object.payment_intent;
    const id = typeof intent === "string" ? intent : intent?.id;
    if (id) intents.add(id);
  }
  return intents;
}

/**
 * @description Re-syncs one purchase's refund/dispute state from Stripe's live records, the same
 * way the webhook's `fulfillment.syncCharge` does.
 * @returns Whether the purchase changed (or, in a dry run, would have).
 */
async function syncIntentCharge(stripePaymentIntentId: string, dryRun: boolean): Promise<boolean> {
  const synced = await paymentsRepo.purchase.syncCharge(
    { stripePaymentIntentId },
    () => resolveChargeState(stripePaymentIntentId),
    { write: !dryRun },
  );
  if (!synced.found || !synced.updated) return false;

  logger.info(
    { paymentIntent: stripePaymentIntentId, from: synced.from, to: synced.to, dryRun },
    "payments.reconcile.charge_update",
  );
  return true;
}

export async function purchases(days: number, dryRun: boolean): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { scanned: 0, inserted: 0, updated: 0, failed: 0 };
  const stripe = getPaymentProcessor();
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const [listedSuccessTimes, successTimesError] = await tryCatch(getSuccessTimes(sinceSec));
  if (successTimesError)
    logger.warn({ err: successTimesError }, "payments.reconcile.success_events_unavailable");
  const successTimes = listedSuccessTimes ?? new Map<string, Date>();
  const sessions = stripe.checkout.sessions.list({
    status: "complete",
    created: { gte: sinceSec },
    expand: ["data.payment_intent.latest_charge"],
    limit: 100,
  });

  const synced = new Set<string>();
  for await (const session of sessions) {
    if (
      session.mode !== "payment" ||
      session.payment_status === "unpaid" ||
      !session.metadata?.planId
    )
      continue;

    // someone else's session on the same Stripe account (a Payment Link, another app) is skipped
    // quietly - not inserted as a purchase, and not counted failed for lacking our metadata
    const [ours, oursError] = await tryCatch(isOurs(session));
    if (oursError) {
      summary.scanned++;
      summary.failed++;
      logger.error({ err: oursError, session: session.id }, "payments.reconcile");
      continue;
    }
    if (!ours) continue;

    summary.scanned++;
    const intent = session.payment_intent as Stripe.PaymentIntent | string | null;
    const intentId = typeof intent === "string" ? intent : intent?.id;
    if (intentId) synced.add(intentId);
    const [result, error] = await tryCatch(
      reconcileSession(session, dryRun, successTimes.get(session.id)),
    );
    if (error) {
      summary.failed++;
      logger.error({ err: error, session: session.id }, "payments.reconcile");
      continue;
    }
    if (result.inserted) summary.inserted++;
    if (result.updated) summary.updated++;
  }
  const [chargeIntents, chargeEventsError] = await tryCatch(getChargeEventIntents(sinceSec));
  if (chargeEventsError) {
    summary.failed++;
    logger.error({ err: chargeEventsError }, "payments.reconcile.charge_events_unavailable");
  }
  for (const intentId of chargeIntents ?? []) {
    if (synced.has(intentId)) continue;
    const [updated, error] = await tryCatch(syncIntentCharge(intentId, dryRun));
    if (error) {
      summary.failed++;
      logger.error({ err: error, paymentIntent: intentId }, "payments.reconcile.charge");
      continue;
    }
    if (updated) summary.updated++;
  }

  // last, after the session scan has recorded what it could: a row still `processing` now is one
  // that scan didn't settle - outside its window, or failed rather than paid
  const [processing, processingError] = await tryCatch(paymentsRepo.checkout.get.processing());
  if (processingError) {
    summary.failed++;
    logger.error({ err: processingError }, "payments.reconcile.processing_unavailable");
  }
  for (const row of processing ?? []) {
    const [result, error] = await tryCatch(
      settleProcessingCheckout(row.stripeCheckoutSessionId, dryRun, successTimes),
    );
    if (error) {
      summary.failed++;
      logger.error(
        { err: error, session: row.stripeCheckoutSessionId },
        "payments.reconcile.processing",
      );
      continue;
    }
    if (result === "inserted") summary.inserted++;
    if (result === "failed" || result === "completed") summary.updated++;
  }
  return summary;
}

// a payment intent in one of these after its checkout completed means the delayed payment failed:
// Stripe sends it back to `requires_payment_method` when a bank debit is returned, or `canceled`
const FAILED_INTENT_STATUSES: readonly string[] = ["requires_payment_method", "canceled"];

/**
 * @description Settles one `processing` checkout row from Stripe's live state, for when the webhook
 * that should have (`checkout.session.async_payment_failed` or `_succeeded`) never landed. A failed
 * payment moves the row to `failed`, freeing the (user, plan) slot - without this, the buyer
 * couldn't buy the plan again until the row's `PROCESSING_TTL_SEC` deadline, weeks away. A paid
 * one is recorded through `confirm`, which completes the row; one already recorded just has its
 * row completed. One still settling is left alone. Operation must be wrapped in try-catch
 * @returns what changed - "inserted", "completed", "failed" - or null for nothing.
 */
async function settleProcessingCheckout(
  sessionId: string,
  dryRun: boolean,
  successTimes: Map<string, Date>,
): Promise<"inserted" | "completed" | "failed" | null> {
  const session = await getPaymentProcessor().checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge"],
  });
  const intent = session.payment_intent as Stripe.PaymentIntent | null;

  if (session.payment_status === "paid") {
    const recorded = await paymentsRepo.purchase.get.bySessionAnyUser({
      stripeCheckoutSessionId: sessionId,
    });
    if (dryRun) {
      logger.info(
        { session: sessionId, dryRun, recorded: recorded !== null },
        "payments.reconcile.processing_paid",
      );
      return recorded ? "completed" : "inserted";
    }
    if (recorded) return (await markCompleted(sessionId)) ? "completed" : null;
    const inserted = await confirm(session, successTimes.get(sessionId) ?? fallbackPaidAt(session));
    logger.info({ session: sessionId, inserted }, "payments.reconcile.processing_paid");
    return inserted ? "inserted" : null;
  }

  if (intent && FAILED_INTENT_STATUSES.includes(intent.status)) {
    logger.info(
      { session: sessionId, intentStatus: intent.status, dryRun },
      "payments.reconcile.processing_failed",
    );
    if (dryRun) return "failed";
    return (await markFailed(sessionId)) ? "failed" : null;
  }

  return null;
}

export type SubscriptionReconcileSummary = {
  checked: number;
  updated: number;
  failed: number;
};

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
 * correcting it if anything differs. Operation must be wrapped in try-catch
 */
async function reconcileSubscription(
  row: Subscription,
  current: Stripe.Subscription,
  dryRun: boolean,
): Promise<{ updated: boolean }> {
  const target = subscriptionFieldsFromStripe(current);

  const priceId = current.items.data[0]?.price.id;
  if (priceId) {
    const plan = await paymentsRepo.plan.get.byPriceId(priceId);
    if (plan) target.plan = plan.name.toLowerCase();
  }

  if (row.stripeSubscriptionId !== current.id) target.stripeSubscriptionId = current.id;

  if (!target.stripeSubscriptionId && !subscriptionFieldsDiffer(row, target))
    return { updated: false };

  if (!dryRun) {
    const written = await paymentsRepo.subscription.updateFields(
      { stripeSubscriptionId: current.id },
      target,
      row,
    );
    if (!written) {
      logger.info(
        { subscription: current.id, from: row, to: target },
        "payments.reconcile.subscription_changed",
      );
      return { updated: false };
    }
  }
  logger.info(
    { subscription: current.id, from: row, to: target, dryRun },
    "payments.reconcile.subscription_update",
  );
  return { updated: true };
}

export async function subscriptions(dryRun: boolean): Promise<SubscriptionReconcileSummary> {
  const summary: SubscriptionReconcileSummary = { checked: 0, updated: 0, failed: 0 };
  const rows = await paymentsRepo.subscription.getReconcilable();

  const byStripeId = new Map<string, Subscription>();
  const unlinked = new Map<string, Subscription>();
  for (const row of rows) {
    if (row.stripeSubscriptionId) byStripeId.set(row.stripeSubscriptionId, row);
    else unlinked.set(row.id, row);
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
    if (row) {
      matched.add(current.id);
      await check(row, current);
      continue;
    }

    const orphanId = current.metadata?.subscriptionId;
    const orphan = orphanId ? unlinked.get(orphanId) : undefined;
    if (!orphan) continue;
    const customerId =
      typeof current.customer === "string" ? current.customer : current.customer?.id;
    if (
      current.metadata?.referenceId !== orphan.referenceId ||
      (orphan.stripeCustomerId && customerId !== orphan.stripeCustomerId)
    ) {
      summary.checked++;
      summary.failed++;
      logger.error(
        { subscription: current.id, row: orphan.id },
        "payments.reconcile.subscription_link_mismatch",
      );
      continue;
    }
    unlinked.delete(orphan.id);
    logger.warn({ subscription: current.id, row: orphan.id }, "payments.reconcile.subscription_link");
    await check(orphan, current);
  }

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
