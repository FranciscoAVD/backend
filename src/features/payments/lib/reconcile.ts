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
