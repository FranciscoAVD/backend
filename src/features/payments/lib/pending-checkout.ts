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
/**
 * How long a `POST /checkout` reservation holds the (user, plan) slot before a real session id
 * replaces it. Generous on purpose: it has to outlast `ensureStripeCustomer` plus
 * `checkout.sessions.create`, including the Stripe SDK's own timeout and retries. If the request
 * dies mid-way, the slot frees itself after this long.
 */
export const RESERVATION_TTL_SEC = 60 * 5;
const RESERVATION_PREFIX = "reserving:";

const key = (sessionId: string) => `checkout:${sessionId}`;
// one active pointer per (user, plan), so the non-repeatable guard can check "does this user
// already have an open/processing checkout for this plan" without scanning by sessionId. Holds
// either a session id, or a `reserving:<token>` placeholder while POST /checkout is still
// talking to Stripe (see reservePendingCheckout)
const pointerKey = (userId: string, planId: number) =>
  `checkout:active:${userId}:${planId}`;

// compare-and-delete: a plain GET then DEL can delete a value another request wrote in between
const DEL_IF_EQUALS = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;
// refreshes the pointer's TTL if it still points at this session, or claims it if it's free;
// leaves it alone if another session has taken the slot since
const EXTEND_OR_CLAIM = `
local current = redis.call("GET", KEYS[1])
if current == false or current == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
  return 1
end
return 0
`;

async function setPointer(
  userId: string,
  planId: number,
  sessionId: string,
  ttlSec: number,
): Promise<void> {
  await redis.set(pointerKey(userId, planId), sessionId, "EX", ttlSec);
}

async function delIfEquals(redisKey: string, value: string): Promise<void> {
  await redis.send("EVAL", [DEL_IF_EQUALS, "1", redisKey, value]);
}

/**
 * @description Clears the (user, plan) pointer only if it still points at this session - so
 * removing an older, already-superseded session's key can't clobber a newer one's pointer.
 * Atomic, so a newer session written between the check and the delete is never lost.
 */
async function clearPointerIfMatches(
  userId: string,
  planId: number,
  sessionId: string,
): Promise<void> {
  await delIfEquals(pointerKey(userId, planId), sessionId);
}

/**
 * @description Keeps the (user, plan) pointer alive for as long as this session's own entry -
 * without this, a `processing` entry (14 days) would outlive its 24h pointer and the
 * non-repeatable guard would stop seeing it after the first day.
 */
async function extendPointer(
  userId: string,
  planId: number,
  sessionId: string,
  ttlSec: number,
): Promise<void> {
  await redis.send("EVAL", [
    EXTEND_OR_CLAIM,
    "1",
    pointerKey(userId, planId),
    sessionId,
    String(ttlSec),
  ]);
}

/**
 * @description Whether a pointer value currently holds the slot: a live reservation always does
 * (its own TTL bounds it), a session id only while that session is still open/processing.
 */
async function isActivePointer(value: string): Promise<boolean> {
  if (value.startsWith(RESERVATION_PREFIX)) return true;
  const pending = await getPendingCheckout(value);
  return pending?.status === "open" || pending?.status === "processing";
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
  const current = await redis.get(pointerKey(userId, planId));
  if (!current) return false;
  if (await isActivePointer(current)) return true;

  // stale pointer (its session's key expired, or ended failed/expired) - self-heal rather than
  // block forever, but only if it hasn't been replaced in the meantime
  await delIfEquals(pointerKey(userId, planId), current);
  return false;
}

/**
 * @description Atomically claims the (user, plan) slot for a checkout that's about to be created,
 * so two concurrent `POST /checkout` requests can't both pass the guard and both reach Stripe.
 * Replaces the separate "is there a pending checkout?" check, which left a window between the
 * check and `savePendingCheckout` writing the pointer. `savePendingCheckout` later overwrites
 * the reservation with the real session id; `releaseReservation` frees it if creation fails.
 * @returns A reservation token if the slot was free, or null if an open/processing checkout (or
 * another in-flight reservation) already holds it.
 */
export async function reservePendingCheckout(
  userId: string,
  planId: number,
): Promise<string | null> {
  const token = `${RESERVATION_PREFIX}${crypto.randomUUID()}`;
  const pointer = pointerKey(userId, planId);

  // a few attempts, not one: a stale pointer is cleared and the slot retried, and a pointer
  // that expires between the failed SET and the GET just means trying again
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await redis.send("SET", [
      pointer,
      token,
      "NX",
      "EX",
      String(RESERVATION_TTL_SEC),
    ]);
    if (claimed === "OK") return token;

    const current = await redis.get(pointer);
    if (current === null) continue;
    if (await isActivePointer(current)) return null;
    await delIfEquals(pointer, current);
  }
  return null;
}

/**
 * @description Frees a reservation from `reservePendingCheckout` when checkout creation failed
 * before a session was saved. A no-op if the reservation already expired or was replaced.
 */
export async function releaseReservation(
  userId: string,
  planId: number,
  token: string,
): Promise<void> {
  await delIfEquals(pointerKey(userId, planId), token);
}

// open -> processing -> {failed, expired}; failed/expired share a rank so neither can
// flip into the other. Stripe's retries/out-of-order delivery mean a later event for
// the same session can carry an earlier status - that must never move the status backward.
const STATUS_RANK: Record<PendingCheckout["status"], number> = {
  open: 0,
  processing: 1,
  failed: 2,
  expired: 2,
};

// what a transition does to the (user, plan) pointer: `extend` keeps it alive as long as the
// session's own entry (still holding the slot), `clear` frees the slot (terminal status)
type PointerAction = "extend" | "clear";

async function transition(
  sessionId: string,
  status: PendingCheckout["status"],
  ttlSec: number,
  pointer: PointerAction,
): Promise<boolean> {
  const pending = await getPendingCheckout(sessionId);
  if (!pending) return false;
  if (STATUS_RANK[status] < STATUS_RANK[pending.status]) return false;

  // writes the status directly, unlike savePendingCheckout, which would also repoint the
  // (user, plan) pointer at this session - a retried transition for an old, superseded
  // session must never drag the pointer back off a newer session that's since taken it over
  // (extendPointer/clearPointerIfMatches both leave a newer session's pointer alone)
  await redis.set(
    key(sessionId),
    JSON.stringify({ ...pending, status }),
    "EX",
    ttlSec,
  );
  if (pointer === "extend")
    await extendPointer(pending.userId, pending.planId, sessionId, ttlSec);
  else await clearPointerIfMatches(pending.userId, pending.planId, sessionId);
  return true;
}

/**
 * @description Marks a checkout as paid-but-unsettled and extends both its TTL and its (user,
 * plan) pointer's to `PROCESSING_TTL_SEC`, so the non-repeatable guard keeps blocking a second
 * checkout for as long as this one can still settle.
 * @returns false if there was no pending entry to update, or if it's already failed/expired
 * (a retried/out-of-order event arriving after a terminal status must not resurrect it).
 */
export async function markProcessing(sessionId: string): Promise<boolean> {
  return transition(sessionId, "processing", PROCESSING_TTL_SEC, "extend");
}

/**
 * @description Marks a checkout as failed (e.g. a delayed payment method was declined) and
 * immediately frees the (user, plan) slot so the user can retry right away.
 * @returns false if there was no pending entry to update, or if it's already expired.
 */
export async function markFailed(sessionId: string): Promise<boolean> {
  return transition(sessionId, "failed", TERMINAL_TTL_SEC, "clear");
}

/**
 * @description Marks a checkout as expired (the user never completed it) and immediately frees
 * the (user, plan) slot so the user can retry right away.
 * @returns false if there was no pending entry to update, or if it's already failed.
 */
export async function markExpired(sessionId: string): Promise<boolean> {
  return transition(sessionId, "expired", TERMINAL_TTL_SEC, "clear");
}

export async function removePendingCheckout(sessionId: string): Promise<void> {
  const pending = await getPendingCheckout(sessionId);
  await redis.del(key(sessionId));
  if (pending)
    await clearPointerIfMatches(pending.userId, pending.planId, sessionId);
}
