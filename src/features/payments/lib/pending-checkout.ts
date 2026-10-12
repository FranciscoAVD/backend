import { redis } from "@/lib/redis";
import type { Payment } from "@f/payments/lib/types";

/**
 * @description An in-flight one-time checkout. Lives in Redis until Stripe confirms
 * the payment; only then is a `purchase` row written to the DB. `failed`/`expired` are
 * short-lived terminal states (see `markFailed`/`markExpired`) so a polling client can
 * tell "your payment failed" apart from "this session never existed."
 */
export type PendingCheckout = {
  // always the real, live user who started the checkout - never null, unlike
  // a purchase row's own userId once that user is later deleted
  userId: string;
  planId: Payment.Plan["id"];
  status: "open" | "processing" | "failed" | "expired";
};

/** Matches the Checkout Session `expires_at` set in `createCheckout`. */
export const PENDING_CHECKOUT_TTL_SEC = 60 * 60 * 24;
/** Delayed payment methods (e.g. bank debits) can take several days to settle. */
export const PROCESSING_TTL_SEC = 60 * 60 * 24 * 14;
/** How long a failed/expired checkout's terminal status stays visible to a polling client. */
const TERMINAL_TTL_SEC = 60 * 60;

const key = (sessionId: string) => `checkout:${sessionId}`;
// one active pointer per (user, plan), so the non-repeatable guard can check "does this user
// already have an open/processing checkout for this plan" without scanning by sessionId
const pointerKey = (userId: string, planId: number) =>
  `checkout:active:${userId}:${planId}`;

async function setPointer(
  userId: string,
  planId: number,
  sessionId: string,
  ttlSec: number,
): Promise<void> {
  await redis.set(pointerKey(userId, planId), sessionId, "EX", ttlSec);
}

/**
 * @description Clears the (user, plan) pointer only if it still points at this session - so
 * removing an older, already-superseded session's key can't clobber a newer one's pointer.
 */
async function clearPointerIfMatches(
  userId: string,
  planId: number,
  sessionId: string,
): Promise<void> {
  const current = await redis.get(pointerKey(userId, planId));
  if (current === sessionId) await redis.del(pointerKey(userId, planId));
}

export async function savePendingCheckout(
  sessionId: string,
  data: PendingCheckout,
  ttlSec: number,
): Promise<void> {
  await redis.set(key(sessionId), JSON.stringify(data), "EX", ttlSec);
  await setPointer(data.userId, data.planId, sessionId, ttlSec);
}

export async function getPendingCheckout(
  sessionId: string,
): Promise<PendingCheckout | null> {
  const value = await redis.get(key(sessionId));
  return value ? (JSON.parse(value) as PendingCheckout) : null;
}

/**
 * @description Whether the user has an open/processing (not failed/expired) checkout for this
 * plan right now. Used to block a second checkout on a non-repeatable plan before Stripe is
 * even involved - the realistic "two tabs" case, closed before `confirmCheckout`'s own re-check
 * (which catches the narrower race this can't).
 */
export async function hasActivePendingCheckout(
  userId: string,
  planId: number,
): Promise<boolean> {
  const sessionId = await redis.get(pointerKey(userId, planId));
  if (!sessionId) return false;

  const pending = await getPendingCheckout(sessionId);
  if (!pending) {
    // stale pointer (its own key already expired) - self-heal rather than block forever
    await redis.del(pointerKey(userId, planId));
    return false;
  }
  return pending.status === "open" || pending.status === "processing";
}

async function transition(
  sessionId: string,
  status: PendingCheckout["status"],
  ttlSec: number,
  clearPointer: boolean,
): Promise<boolean> {
  const pending = await getPendingCheckout(sessionId);
  if (!pending) return false;

  await savePendingCheckout(sessionId, { ...pending, status }, ttlSec);
  if (clearPointer)
    await clearPointerIfMatches(pending.userId, pending.planId, sessionId);
  return true;
}

/**
 * @description Marks a checkout as paid-but-unsettled and extends its TTL.
 * @returns false if there was no pending entry to update.
 */
export async function markProcessing(sessionId: string): Promise<boolean> {
  return transition(sessionId, "processing", PROCESSING_TTL_SEC, false);
}

/**
 * @description Marks a checkout as failed (e.g. a delayed payment method was declined) and
 * immediately frees the (user, plan) slot so the user can retry right away.
 * @returns false if there was no pending entry to update.
 */
export async function markFailed(sessionId: string): Promise<boolean> {
  return transition(sessionId, "failed", TERMINAL_TTL_SEC, true);
}

/**
 * @description Marks a checkout as expired (the user never completed it) and immediately frees
 * the (user, plan) slot so the user can retry right away.
 * @returns false if there was no pending entry to update.
 */
export async function markExpired(sessionId: string): Promise<boolean> {
  return transition(sessionId, "expired", TERMINAL_TTL_SEC, true);
}

export async function removePendingCheckout(sessionId: string): Promise<void> {
  const pending = await getPendingCheckout(sessionId);
  await redis.del(key(sessionId));
  if (pending)
    await clearPointerIfMatches(pending.userId, pending.planId, sessionId);
}
