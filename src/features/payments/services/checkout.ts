import { env } from "@/env";
import type { Payment } from "@f/payments/lib/types";
import { paymentsRepo } from "@f/payments/repo";
import { ensureCustomer } from "@f/payments/services/account";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import {
  PENDING_CHECKOUT_TTL_SEC,
  CHECKOUT_SESSION_EXPIRY_SEC,
  PROCESSING_TTL_SEC,
  RESERVATION_TTL_SEC,
  CHECKOUT_TRANSITIONS_FROM,
  CHECKOUT_SESSION_EXPIRY_MARGIN_SEC,
  CHECKOUT_SOURCE_METADATA_KEY,
  CHECKOUT_SOURCE_METADATA_VALUE,
} from "@f/payments/lib/constants";
import { isUserDeleting } from "@f/payments/lib/state/deletion-guard";
import { encodeDurationDays, encodeOverlapping } from "@f/payments/lib/utils";
import { getCheckoutSessionParams } from "@f/payments/lib/checkout-extensions";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";
import type Stripe from "stripe";

type CheckoutUser = { userId: string; name: string; email: string };

export type CheckoutResult =
  | { kind: "created"; sessionId: string; url: string | null }
  | { kind: "resumed"; sessionId: string; url: string }
  | { kind: "owned"; existingPurchaseId: number }
  | { kind: "slot_taken" }
  | { kind: "deleting" }
  | { kind: "not_found" }
  | { kind: "wrong_type" };

const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000);

/**
 * Thrown by `createCheckout` when its claimed row no longer held the (user, plan) slot by the time
 * the session existed - another checkout for the same plan holds it instead.
 */
export class CheckoutSlotLostError extends Error {
  constructor() {
    super("Checkout reservation lapsed; another checkout holds the slot");
    this.name = "CheckoutSlotLostError";
  }
}

/**
 * @description Creates a one-time Stripe Checkout Session and opens the `checkout` row already
 * claimed for it. The plan's `durationDays` and `overlapping` are snapshotted onto the session's
 * metadata here, at checkout time, so an admin edit made while the payment is still settling can't
 * change what this buyer gets. Exported (not barrel-listed) so its Stripe-param details stay
 * independently testable from `start`'s full orchestration. Not wrapped in try-catch itself - a
 * thrown error (anything other than `CheckoutSlotLostError`, which `start` handles) propagates to
 * the caller.
 * @param claimed the row `paymentsRepo.checkout.claim` returned for this (user, plan)
 */
export async function createCheckout(
  user: { userId: string; stripeCustomerId: string },
  plan: Payment.Plan,
  claimed: Pick<Payment.Checkout, "id">,
): Promise<{ sessionId: string; url: string | null }> {
  const extra = (await getCheckoutSessionParams({ user, plan })) ?? {};
  const { metadata: extraMetadata, payment_intent_data: extraPID, line_items: extraLineItems, ...rest } = extra;

  const metadata = {
    ...extraMetadata,
    [CHECKOUT_SOURCE_METADATA_KEY]: CHECKOUT_SOURCE_METADATA_VALUE,
    userId: user.userId,
    planId: String(plan.id),
    durationDays: encodeDurationDays(plan.durationDays),
    overlapping: encodeOverlapping(plan.overlapping),
  };

  const session = await getPaymentProcessor().checkout.sessions.create({
    ...rest,
    mode: "payment",
    customer: user.stripeCustomerId,
    line_items: extraLineItems ?? [{ price: plan.stripePriceId, quantity: 1 }],
    client_reference_id: user.userId,
    metadata,
    payment_intent_data: { ...extraPID, metadata: { ...extraPID?.metadata, ...metadata } },
    success_url: `${env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/checkout/cancel`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_EXPIRY_SEC,
  });

  const opened = await paymentsRepo.checkout.open(claimed, {
    stripeCheckoutSessionId: session.id,
    url: session.url,
    // a repeatable plan releases the slot the moment its session is payable: buying it again is
    // the point, and a settling purchase mustn't block the next one
    slot: plan.repeatable ? null : 1,
    expiresAt: expiresIn(PENDING_CHECKOUT_TTL_SEC),
  });

  if (!opened) {
    const [, expireError] = await tryCatch(
      getPaymentProcessor().checkout.sessions.expire(session.id),
    );
    if (expireError)
      logger.warn({ err: expireError, session: session.id }, "payments.checkout.expire_lost");
    throw new CheckoutSlotLostError();
  }

  return { sessionId: session.id, url: session.url };
}

/**
 * @description The full `POST /checkout` flow: checks the plan, blocks a deleting account, then
 * either resumes an open session or claims the (user, plan) slot, creates the Stripe Checkout
 * Session, and re-checks the deletion flag once more before handing back a payable session.
 * Returns a structured `kind` instead of an HTTP response - `route.ts` owns every status code and
 * message.
 */
export async function start(
  user: CheckoutUser,
  input: { planId: number },
): Promise<CheckoutResult> {
  const plan = await paymentsRepo.plan.get.one({ id: input.planId });
  if (!plan || !plan.active) return { kind: "not_found" };
  if (plan.type !== "one_time") return { kind: "wrong_type" };

  if (await isUserDeleting(user.userId)) return { kind: "deleting" };

  let claimed: Pick<Payment.Checkout, "id"> | null = null;
  const release = async () => {
    if (!claimed) return;
    const [, releaseError] = await tryCatch(paymentsRepo.checkout.release(claimed));
    if (releaseError)
      logger.warn(
        { err: releaseError, user: user.userId, plan: plan.id },
        "payments.checkout.release_reservation",
      );
  };

  const resume = async (): Promise<CheckoutResult | null> => {
    const [resumable, resumeError] = await tryCatch(
      paymentsRepo.checkout.get.resumable({ userId: user.userId, planId: plan.id }),
    );
    if (resumeError)
      logger.warn(
        { err: resumeError, user: user.userId, plan: plan.id },
        "payments.checkout.resume",
      );
    return resumable
      ? { kind: "resumed", sessionId: resumable.stripeCheckoutSessionId, url: resumable.url }
      : null;
  };

  const blockIfOwned = async (): Promise<CheckoutResult | null> => {
    const existing = await paymentsRepo.purchase.getBlocking({ userId: user.userId, planId: plan.id });
    if (!existing) return null;

    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "checkout_blocked_existing_purchase",
        userId: user.userId,
        planId: plan.id,
        existingPurchaseId: existing.id,
      }),
    );
    if (auditError)
      logger.warn(
        { err: auditError, user: user.userId, plan: plan.id },
        "payments.audit.write_failed",
      );
    return { kind: "owned", existingPurchaseId: existing.id };
  };

  // both plan types claim the same slot, so only one Stripe session is ever in flight per
  // (user, plan). A non-repeatable plan checks ownership first, since owning it rules the checkout
  // out entirely; a repeatable one checks for a resumable session first, because its own open
  // session no longer holds the slot and would otherwise be passed over for a second one
  if (!plan.repeatable) {
    const blocked = await blockIfOwned();
    if (blocked) return blocked;
  } else {
    const resumed = await resume();
    if (resumed) return resumed;
  }

  claimed = await paymentsRepo.checkout.claim(
    { userId: user.userId },
    { planId: plan.id, expiresAt: expiresIn(RESERVATION_TTL_SEC) },
  );

  if (!claimed) {
    // for a repeatable plan this is just two requests racing - the resume above already ran
    if (plan.repeatable) return { kind: "slot_taken" };

    const resumed = await resume();
    if (resumed) return resumed;

    const [, auditError] = await tryCatch(
      paymentsRepo.audit.add({
        type: "checkout_blocked_pending_checkout",
        userId: user.userId,
        planId: plan.id,
      }),
    );
    if (auditError)
      logger.warn(
        { err: auditError, user: user.userId, plan: plan.id },
        "payments.audit.write_failed",
      );
    return { kind: "slot_taken" };
  }

  // everything below holds the claimed row, which must always be released - on a thrown error (a
  // DB/Stripe call failing) just as much as on a normal return, or the slot sits locked until the
  // next claim sweeps it past RESERVATION_TTL_SEC
  try {
    if (!plan.repeatable) {
      const blockedAfterReserve = await blockIfOwned();
      if (blockedAfterReserve) return blockedAfterReserve;
    }

    const stripeCustomerId = await ensureCustomer({
      id: user.userId,
      name: user.name,
      email: user.email,
    });

    const [res, error] = await tryCatch(
      createCheckout({ userId: user.userId, stripeCustomerId }, plan, claimed),
    );

    if (error) {
      if (error instanceof CheckoutSlotLostError) {
        logger.warn({ user: user.userId, plan: plan.id }, "payments.checkout.slot_lost");
        return { kind: "slot_taken" };
      }
      throw error;
    }

    // the deletion flag again, now the session exists: a deletion that started after the check
    // above may have listed the user's open sessions before this one existed
    const [deletingNow, recheckError] = await tryCatch(isUserDeleting(user.userId));
    if (recheckError)
      logger.warn({ err: recheckError, user: user.userId }, "payments.checkout.deletion_guard");
    if (deletingNow) {
      const [, expireError] = await tryCatch(expire(res.sessionId));
      if (expireError)
        logger.error(
          { err: expireError, user: user.userId, session: res.sessionId },
          "payments.checkout.deletion_guard.expire",
        );
      return { kind: "deleting" };
    }

    return { kind: "created", sessionId: res.sessionId, url: res.url };
  } finally {
    await release();
  }
}

/**
 * @description Whether this app created a Checkout Session - and so whether the webhook, the
 * reconciler or plan retirement may act on it. True if it carries this app's source tag
 * (`CHECKOUT_SOURCE_METADATA_KEY`, set on every session since the tag existed), or - for a session
 * created before then - if a `checkout` row was recorded for it. A session from anything else on
 * the same Stripe account (a Payment Link, the Dashboard, another app) is neither, even if it
 * happens to carry `planId`/`userId` metadata. Operation must be wrapped in try-catch
 */
export async function isOurs(
  session: Pick<Stripe.Checkout.Session, "id" | "metadata">,
): Promise<boolean> {
  if (session.metadata?.[CHECKOUT_SOURCE_METADATA_KEY] === CHECKOUT_SOURCE_METADATA_VALUE)
    return true;
  const row = await paymentsRepo.checkout.get.bySession({ stripeCheckoutSessionId: session.id });
  return row !== null;
}

/**
 * @description Resolves a checkout's status: the DB purchase once confirmed, otherwise the
 * `checkout` row. Both are scoped to the user. A `reserving` row past its own `expiresAt`, or an
 * `open` one whose Stripe session has expired (`CHECKOUT_SESSION_EXPIRY_MARGIN_SEC` before the
 * row's own `expiresAt`), reads as `expired` - nothing has swept it yet, but it's no longer
 * payable. Operation must be wrapped in try-catch
 */
export async function status(
  checkout: { userId: string } & Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<Payment.Purchase["status"] | Payment.Checkout["status"] | null> {
  const purchase = await paymentsRepo.purchase.get.bySession(checkout);
  if (purchase) return purchase.status;

  const pending = await paymentsRepo.checkout.get.bySession(checkout);
  if (!pending || pending.userId !== checkout.userId) return null;
  const deadAt =
    pending.status === "open"
      ? pending.expiresAt.getTime() - CHECKOUT_SESSION_EXPIRY_MARGIN_SEC * 1000
      : pending.expiresAt.getTime();
  return (pending.status === "open" || pending.status === "reserving") && deadAt <= Date.now()
    ? "expired"
    : pending.status;
}

/**
 * @description Expires a one-time Checkout Session this app created and marks its checkout row
 * expired, freeing the (user, plan) slot. Operation must be wrapped in try-catch
 */
export async function expire(sessionId: string): Promise<void> {
  await getPaymentProcessor().checkout.sessions.expire(sessionId);
  await markExpired(sessionId);
}

/**
 * @description Marks a checkout as paid-but-unsettled and extends its deadline to
 * `PROCESSING_TTL_SEC`, so the slot keeps blocking a second checkout for as long as this one can
 * still settle.
 * @returns false if there was no checkout row to update, or if it already reached a terminal
 * status (a retried/out-of-order event arriving after one must not resurrect it).
 */
export async function markProcessing(sessionId: string): Promise<boolean> {
  const res = await paymentsRepo.checkout.transition(
    { stripeCheckoutSessionId: sessionId },
    "processing",
    { from: CHECKOUT_TRANSITIONS_FROM.processing, expiresAt: expiresIn(PROCESSING_TTL_SEC) },
  );
  return res !== null;
}

/**
 * @description Marks a checkout as failed (e.g. a delayed payment method was declined), freeing
 * the (user, plan) slot so the user can retry right away.
 * @returns false if there was no checkout row to update, or if it's already expired/completed.
 */
export async function markFailed(sessionId: string): Promise<boolean> {
  const res = await paymentsRepo.checkout.transition(
    { stripeCheckoutSessionId: sessionId },
    "failed",
    { from: CHECKOUT_TRANSITIONS_FROM.failed },
  );
  return res !== null;
}

/**
 * @description Marks a checkout as expired (the user never completed it), freeing the (user, plan)
 * slot so the user can retry right away.
 * @returns false if there was no checkout row to update, or if it's already failed/completed.
 */
export async function markExpired(sessionId: string): Promise<boolean> {
  const res = await paymentsRepo.checkout.transition(
    { stripeCheckoutSessionId: sessionId },
    "expired",
    { from: CHECKOUT_TRANSITIONS_FROM.expired },
  );
  return res !== null;
}

/**
 * @description Marks a checkout completed once its `purchase` row exists, freeing the (user, plan)
 * slot. Called last by `services.fulfillment.confirm`, after the insert - any request that then
 * claims the freed slot is guaranteed to see the purchase.
 * @returns false if there was no checkout row to update - a session whose owner was resolved from
 * Stripe metadata alone, with no row of its own (see `fulfillment.ts`'s `resolveOwner`) - or if it
 * already reached a different terminal status.
 */
export async function markCompleted(sessionId: string): Promise<boolean> {
  const res = await paymentsRepo.checkout.transition(
    { stripeCheckoutSessionId: sessionId },
    "completed",
    { from: CHECKOUT_TRANSITIONS_FROM.completed },
  );
  return res !== null;
}
