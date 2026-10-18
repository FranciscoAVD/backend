import Stripe from "stripe";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import { paymentsRepo } from "@f/payments/repo";
import { isOurs, markCompleted } from "@f/payments/services/checkout";
import { decodeDurationDays, decodeOverlapping } from "@f/payments/lib/utils";
import { resolveChargeState } from "@f/payments/lib/stripe/charge-state";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import { sendPurchaseConfirmationEmail } from "@f/payments/lib/purchase-confirmation-email";
import { sendRefundConfirmationEmail } from "@f/payments/lib/refund-confirmation-email";
import { sendDuplicatePurchaseAlert } from "@f/payments/lib/duplicate-purchase-alert-email";
import {
  CHECKOUT_SOURCE_METADATA_KEY,
  CHECKOUT_SOURCE_METADATA_VALUE,
} from "@f/payments/lib/constants";
import type { ChargeSyncResult } from "@f/payments/use-cases/sync-purchase-charge";
import type { Payment } from "@f/payments/lib/types";

const idOf = (ref: string | { id: string } | null) =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

/**
 * @description Who bought what: Stripe's own session metadata, set once at checkout time -
 * the source of truth, since it's what Stripe itself guarantees for this session. The `checkout`
 * row is still read, but only to cross-check: if it exists and disagrees with the metadata on
 * `userId` or `planId`, that's suspicious enough to refuse rather than silently pick one (see
 * `confirm`). The row is never used to supply or override the owner - a session with no resolvable
 * metadata returns null regardless of whether a row exists.
 */
async function resolveOwner(
  session: Stripe.Checkout.Session,
): Promise<{ userId: string; planId: number } | null> {
  const userId = session.metadata?.userId;
  const planId = Number(session.metadata?.planId);
  const fromMetadata = userId && Number.isInteger(planId) ? { userId, planId } : null;

  const [pending, error] = await tryCatch(
    paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: session.id }),
  );
  if (!pending && error)
    logger.warn({ err: error, session: session.id }, "payments.webhook.pending_lookup_failed");

  if (
    pending &&
    fromMetadata &&
    (pending.userId !== fromMetadata.userId || pending.planId !== fromMetadata.planId)
  ) {
    logger.error(
      {
        session: session.id,
        metadataOwner: fromMetadata,
        pendingOwner: { userId: pending.userId, planId: pending.planId },
      },
      "payments.webhook.owner_mismatch",
    );
    throw new Error(
      "Checkout session owner mismatch between Stripe metadata and the checkout row",
    );
  }

  return fromMetadata;
}

/**
 * @description Records a confirmed payment. Both drop cases below throw rather than return, so
 * the caller (the webhook dispatcher, or the reconciler) sees the failure instead of a
 * silently-swallowed success.
 * @param session the paid Checkout Session
 * @param paidAt when the payment actually succeeded - the access window starts here. Defaults to
 * the session's own creation time, only for a caller with nothing better.
 * @returns true if this call inserted the purchase row; false if it was already recorded or the
 * session isn't one of ours.
 */
export async function confirm(
  session: Stripe.Checkout.Session,
  paidAt: Date = new Date(session.created * 1000),
): Promise<boolean> {
  // before anything else: a paid session from a Payment Link, the Dashboard or another app on the
  // same Stripe account is no purchase of ours, whatever its metadata says
  if (!(await isOurs(session))) {
    logger.warn({ session: session.id }, "payments.webhook.not_ours");
    return false;
  }

  const owner = await resolveOwner(session);
  if (!owner) {
    if (!session.metadata?.planId) {
      logger.warn({ session: session.id }, "payments.webhook.not_ours");
      return false;
    }
    logger.error(
      { err: new Error("Paid checkout has no checkout row or metadata"), session: session.id },
      "payments.webhook.metadata",
    );
    throw new Error("Paid checkout has no checkout row or metadata");
  }

  const plan = await paymentsRepo.plan.get.one({ id: owner.planId });
  if (!plan) {
    logger.error(
      { err: new Error("Purchased plan no longer exists"), session: session.id, plan: owner.planId },
      "payments.webhook.plan_missing",
    );
    throw new Error("Purchased plan no longer exists");
  }

  const snapshot = decodeDurationDays(session.metadata?.durationDays);
  if (!snapshot)
    logger.warn(
      { session: session.id, plan: owner.planId },
      "payments.webhook.duration_snapshot_missing",
    );

  const inserted = await paymentsRepo.purchase.add(
    { userId: owner.userId },
    {
      planId: owner.planId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: idOf(session.payment_intent),
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? "",
    },
    {
      ...(snapshot ?? { durationDays: plan.durationDays }),
      overlapping:
        decodeOverlapping(session.metadata?.overlapping)?.overlapping ?? plan.overlapping,
    },
    paidAt,
  );

  const blocking =
    inserted && !plan.repeatable && inserted.userId !== null
      ? await paymentsRepo.purchase.getBlocking(
          { userId: owner.userId, planId: owner.planId },
          { stripeCheckoutSessionId: session.id },
        )
      : null;

  if (blocking && inserted) {
    logger.error(
      {
        err: new Error("Paid checkout for an already-owned non-repeatable plan"),
        session: session.id,
        user: owner.userId,
        plan: owner.planId,
        existingPurchase: blocking.id,
      },
      "payments.webhook.duplicate_purchase",
    );
    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "duplicate_purchase_confirmed",
        userId: owner.userId,
        planId: owner.planId,
        existingPurchaseId: blocking.id,
        stripeCheckoutSessionId: session.id,
        details: {
          stripePaymentIntentId: idOf(session.payment_intent),
          amountTotal: session.amount_total ?? 0,
        },
      }),
    );
    if (auditError)
      logger.warn({ err: auditError, session: session.id }, "payments.audit.write_failed");

    // the buyer has now paid twice for something they can only own once - a person has to decide
    // on the refund, and an audit row nobody is watching isn't enough to make that happen
    const [, alertError] = await tryCatch(
      sendDuplicatePurchaseAlert({
        planName: plan.name,
        buyerUserId: owner.userId,
        existingPurchaseId: blocking.id,
        duplicatePurchaseId: inserted.id,
        stripeCheckoutSessionId: session.id,
        amountTotal: inserted.amountTotal,
        currency: inserted.currency,
      }),
    );
    if (alertError)
      logger.warn({ err: alertError, session: session.id }, "payments.duplicate_alert.send_failed");
  }

  if (inserted) {
    const [, emailError] = await tryCatch(
      sendPurchaseConfirmationEmail({
        userId: inserted.userId ?? owner.userId,
        planName: plan.name,
        amountTotal: inserted.amountTotal,
        currency: inserted.currency,
      }),
    );
    if (emailError)
      logger.warn(
        { err: emailError, session: session.id },
        "payments.purchase_confirmation_email.send_failed",
      );
  }

  // last, after the insert: whichever request then claims the freed slot is guaranteed to see the
  // purchase this call just recorded
  const [, error] = await tryCatch(markCompleted(session.id));
  if (error) logger.warn({ err: error, session: session.id }, "payments.webhook.cleanup");

  return inserted !== null;
}

/**
 * @description Sends the refund-confirmation email, but only when this exact sync actually moved
 * money back (`amountRefunded` increasing) - not keyed on `status` reaching "refunded", since a
 * partial refund alone doesn't flip it (see `purchaseUpdateFromCharge`/`PARTIAL_REFUND_REVOKES_ACCESS`
 * in `lib/utils.ts`) and would otherwise never get an email at all. This also naturally excludes a
 * redelivered webhook re-confirming an already-synced amount, a sync with no diff, and a dispute
 * merely opening (no amount change yet) - all land here with `delta <= 0`. A dispute *lost* does
 * increase `amountRefunded` (resolveChargeState adds it there too, since the chargeback returns the
 * money just as surely as an explicit refund does) and correctly emails the same way. Best-effort:
 * never throws.
 */
async function maybeSendRefundEmail(synced: ChargeSyncResult): Promise<void> {
  if (!synced.found || !synced.to) return;
  if (!synced.purchase.userId) return; // the purchaser's account was since deleted

  const delta = synced.to.amountRefunded - synced.from.amountRefunded;
  if (delta <= 0) return;

  const plan = await paymentsRepo.plan.get.one({ id: synced.purchase.planId });
  const [, emailError] = await tryCatch(
    sendRefundConfirmationEmail({
      userId: synced.purchase.userId,
      planName: plan?.name ?? "your purchase",
      amountRefunded: delta,
      currency: synced.purchase.currency,
    }),
  );
  if (emailError)
    logger.warn({ err: emailError }, "payments.refund_confirmation_email.send_failed");
}

/**
 * @description Syncs a purchase's refund/dispute state from a `charge.*` webhook event, or throws
 * so Stripe retries if the purchase isn't recorded yet. Operation must be wrapped in try-catch
 */
export async function syncCharge(
  paymentIntent: string | { id: string } | null,
): Promise<void> {
  const stripePaymentIntentId = idOf(paymentIntent);
  if (!stripePaymentIntentId) return;

  const synced = await paymentsRepo.purchase.syncCharge({ stripePaymentIntentId }, () =>
    resolveChargeState(stripePaymentIntentId),
  );
  if (synced.found) {
    await maybeSendRefundEmail(synced);
    return;
  }

  if (await isOurPaymentIntent(stripePaymentIntentId))
    throw new Error("Purchase not recorded yet for this payment intent");
}

/**
 * @description Whether a payment intent was paid through one of this app's Checkout Sessions - so
 * a charge event for it with no purchase recorded yet is worth Stripe retrying. Tagged with this
 * app's source since that existed; older ones are resolved through their session (`isOurs`). An
 * untagged intent with no `planId` is never ours, and is settled without that extra lookup -
 * that's every subscription invoice, and anything else on the account.
 */
async function isOurPaymentIntent(stripePaymentIntentId: string): Promise<boolean> {
  const stripe = getPaymentProcessor();
  const intent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
  if (intent.metadata?.[CHECKOUT_SOURCE_METADATA_KEY] === CHECKOUT_SOURCE_METADATA_VALUE)
    return true;
  if (!intent.metadata?.planId) return false;

  const sessions = await stripe.checkout.sessions.list({
    payment_intent: stripePaymentIntentId,
    limit: 1,
  });
  const session = sessions.data[0];
  return session ? isOurs(session) : false;
}

export type RefundResult =
  | { kind: "not_found" }
  | { kind: "no_payment_intent" } // a $0 purchase - nothing was ever charged
  | { kind: "already_refunded" }
  | { kind: "charge_disputed" }
  | { kind: "amount_exceeds_refundable" }
  // the idempotency key was already used for a refund with a different amount/reason
  | { kind: "idempotency_conflict" }
  // Stripe accepted the refund but it then failed or was canceled - no money moved
  | { kind: "refund_failed"; refundId: string; failureReason: string | null }
  | { kind: "refunded"; purchase: Payment.Purchase; refundId: string; replayed: boolean };

const FAILED_REFUND_STATUSES: readonly (string | null | undefined)[] = ["failed", "canceled"];

/**
 * @description Whether Stripe answered a request by replaying the stored result of an earlier one
 * with the same idempotency key. `lastResponse.headers` is a plain lowercase object under the SDK's
 * default Node HTTP client, but a `Headers` instance under its fetch client - both are handled, so
 * swapping clients can't silently turn every replay into a "new" refund.
 */
function isIdempotentReplay(response: { lastResponse?: { headers?: unknown } }): boolean {
  const headers = response.lastResponse?.headers;
  const value =
    headers instanceof Headers
      ? headers.get("idempotent-replayed")
      : (headers as Record<string, string | undefined> | undefined)?.["idempotent-replayed"];
  return value === "true";
}

/**
 * @description Issues a refund through Stripe for a purchase, then pulls the resulting
 * refund/dispute state back the same way the webhook does (`syncCharge`/`resolveChargeState`),
 * rather than recomputing the amount/status math here and risking it drifting from that logic.
 *
 * Idempotency is the caller's `idempotencyKey`, scoped to this purchase: the caller generates one
 * per refund it means to issue and resends the same key only to retry that refund. A retry lands at
 * Stripe as the same refund, never a second one; two genuinely separate refunds (even of the same
 * amount and reason) carry different keys and both go through. Reusing a key with a different
 * amount/reason is rejected by Stripe and reported as `idempotency_conflict`.
 *
 * Stripe replays the *original* response for a reused key - including a refund that has since
 * failed, or an error such as `charge_disputed` - so a replay is detected (`Idempotent-Replayed`)
 * and the refund re-read for its live status. A refund that failed or was canceled comes back as
 * `refund_failed` instead of a success, and the caller needs a new key to try again.
 *
 * The audit entry is written once per real refund - right after Stripe accepts it, not on a replay
 * of it - and records the Stripe refund id, so the log lines up one-to-one with Stripe. A failed
 * sync afterwards is logged as a warning, not thrown: the money already moved, and the
 * `charge.refunded`/`charge.refund.updated` webhook will converge the row once it arrives.
 *
 * Two known Stripe failure modes get their own result instead of bubbling up as a generic
 * failure: refunding a disputed charge (`charge_disputed`), and asking for more than what's left
 * to refund (`amount_too_large`, or any error naming `amount` as the bad param). Anything else
 * still throws, for the route's catch-all to turn into a 500. Operation must be wrapped in
 * try-catch
 */
export async function refund(
  target: Pick<Payment.Purchase, "id">,
  admin: { id: string },
  options: {
    idempotencyKey: string;
    amount?: number;
    reason?: Stripe.RefundCreateParams.Reason;
  },
): Promise<RefundResult> {
  const purchase = await paymentsRepo.purchase.get.byId(target);
  if (!purchase) return { kind: "not_found" };
  if (!purchase.stripePaymentIntentId) return { kind: "no_payment_intent" };
  if (purchase.status === "refunded") return { kind: "already_refunded" };

  const stripe = getPaymentProcessor();
  const idempotencyKey = `refund:${purchase.id}:${options.idempotencyKey}`;
  let created: Stripe.Response<Stripe.Refund>;
  try {
    created = await stripe.refunds.create(
      {
        payment_intent: purchase.stripePaymentIntentId,
        ...(options.amount != null ? { amount: options.amount } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      { idempotencyKey },
    );
  } catch (e) {
    if (e instanceof Stripe.errors.StripeIdempotencyError) return { kind: "idempotency_conflict" };
    if (e instanceof Stripe.errors.StripeInvalidRequestError) {
      if (e.code === "charge_disputed") return { kind: "charge_disputed" };
      if (e.code === "amount_too_large" || e.param === "amount")
        return { kind: "amount_exceeds_refundable" };
    }
    throw e;
  }

  const replayed = isIdempotentReplay(created);
  // a replay carries the refund as it was when first created; only a fresh read shows whether it
  // has failed since
  const current = replayed ? await stripe.refunds.retrieve(created.id) : created;
  if (FAILED_REFUND_STATUSES.includes(current.status)) {
    logger.warn(
      { purchase: purchase.id, refund: current.id, status: current.status, replayed },
      "payments.purchase.refund_failed",
    );
    return {
      kind: "refund_failed",
      refundId: current.id,
      failureReason: current.failure_reason ?? null,
    };
  }

  if (!replayed) {
    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "refund_issued",
        userId: purchase.userId,
        planId: purchase.planId,
        existingPurchaseId: purchase.id,
        stripeCheckoutSessionId: purchase.stripeCheckoutSessionId,
        details: {
          issuedBy: admin.id,
          stripeRefundId: current.id,
          amount: options.amount ?? null,
          reason: options.reason ?? null,
        },
      }),
    );
    if (auditError)
      logger.warn({ err: auditError, purchase: purchase.id }, "payments.audit.write_failed");
  }

  const [synced, syncError] = await tryCatch(
    paymentsRepo.purchase.syncCharge({ stripePaymentIntentId: purchase.stripePaymentIntentId }, () =>
      resolveChargeState(purchase.stripePaymentIntentId!),
    ),
  );
  if (syncError) {
    logger.warn({ err: syncError, purchase: purchase.id }, "payments.purchase.refund_sync_failed");
    return { kind: "refunded", purchase, refundId: current.id, replayed };
  }

  await maybeSendRefundEmail(synced);

  return {
    kind: "refunded",
    purchase: synced.found && synced.to ? { ...purchase, ...synced.to } : purchase,
    refundId: current.id,
    replayed,
  };
}
