/**
 * @description Makes purchases match Stripe for recent one-time checkouts: records paid
 * checkouts whose webhook never landed (e.g. Stripe gave up retrying during a DB outage)
 * and syncs refund/dispute state. Safe to run repeatedly.
 *
 * Usage: bun run payments:reconcile [--days 7] [--dry-run]
 */
import { parseArgs } from "node:util";
import type Stripe from "stripe";
import { getPaymentProcessor } from "@f/payments/payment";
import { confirmCheckout } from "@f/payments/lib/webhook";
import {
  purchaseStatusFromDispute,
  purchaseUpdateFromCharge,
} from "@f/payments/lib/utils";
import { getPurchaseBySession } from "@f/payments/use-cases/get-purchases";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import type { Payment } from "@f/payments/lib/types";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";

const { values } = parseArgs({
  options: {
    // Stripe retries webhooks for up to 3 days
    days: { type: "string", default: "7" },
    "dry-run": { type: "boolean", default: false },
  },
});
const days = Number(values.days);
const dryRun = values["dry-run"];
if (!Number.isInteger(days) || days <= 0) {
  logger.error({ days: values.days }, "payments.reconcile.args");
  process.exit(1);
}

let stripe: Stripe;
const summary = { scanned: 0, inserted: 0, updated: 0, failed: 0 };

type PurchaseState = Pick<Payment.Purchase, "amountRefunded" | "status">;

/** @description What the purchase should look like per Stripe, or null for a 0 total (no charge). */
async function targetState(
  intent: Stripe.PaymentIntent | null,
): Promise<PurchaseState | null> {
  const charge = intent?.latest_charge as Stripe.Charge | null | undefined;
  if (!intent || !charge) return null;

  const target = purchaseUpdateFromCharge(charge);
  if (charge.disputed) {
    const disputes = await stripe.disputes.list({
      payment_intent: intent.id,
      limit: 1,
    });
    const dispute = disputes.data[0];
    if (dispute) target.status = purchaseStatusFromDispute(dispute);
  }
  return target;
}

async function reconcile(session: Stripe.Checkout.Session) {
  const userID = session.metadata?.userID;
  if (!userID) throw new Error("Checkout session has no userID metadata");

  const existing = await getPurchaseBySession({
    userID,
    stripeCheckoutSessionId: session.id,
  });

  let current: PurchaseState | null = existing;
  if (!existing) {
    logger.info({ session: session.id, dryRun }, "payments.reconcile.insert");
    summary.inserted++;
    if (!dryRun) await confirmCheckout(session);
    // a freshly recorded purchase starts out paid with nothing refunded
    current = { status: "paid", amountRefunded: 0 };
  }

  const intent = session.payment_intent as Stripe.PaymentIntent | null;
  const target = await targetState(intent);
  if (
    !intent ||
    !target ||
    (current?.status === target.status &&
      current.amountRefunded === target.amountRefunded)
  )
    return;

  logger.info(
    { session: session.id, from: current, to: target, dryRun },
    "payments.reconcile.update",
  );
  summary.updated++;
  if (!dryRun)
    await updatePurchaseByPaymentIntent(
      { stripePaymentIntentId: intent.id },
      target,
    );
}

async function run() {
  stripe = getPaymentProcessor();
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
      !session.metadata?.planID
    )
      continue;

    summary.scanned++;
    const [, error] = await tryCatch(reconcile(session));
    if (error) {
      summary.failed++;
      logger.error({ err: error, session: session.id }, "payments.reconcile");
    }
  }
}

// setup or listing failures (bad key, Stripe down) end the run; per-session ones don't
const [, runError] = await tryCatch(run());
if (runError) {
  summary.failed++;
  logger.error({ err: runError }, "payments.reconcile.run");
}

logger.info({ ...summary, days, dryRun }, "payments.reconcile.summary");
process.exit(summary.failed ? 1 : 0);
