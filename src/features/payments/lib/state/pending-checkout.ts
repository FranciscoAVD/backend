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
  // the Stripe-hosted page for this session, so a buyer who closed the tab can be sent back to
  // it (see getResumableCheckout) instead of being locked out until the session expires. Absent
  // on entries written before this field existed
  url?: string;
};

/** The Redis entry's own TTL - no longer matches the Stripe session's `expires_at` (see below). */
export const PENDING_CHECKOUT_TTL_SEC = 60 * 60 * 24;
/**
 * The Stripe Checkout Session's own `expires_at`, kept 10 minutes shorter than
 * `PENDING_CHECKOUT_TTL_SEC` so the Redis entry always outlives the Stripe session, never the
 * other way around. `checkout.session.expired`'s webhook can lag; without this margin, a session
 * Stripe has already expired but whose webhook hasn't landed yet still shows `open` in Redis, and
 * `getResumableCheckout` could hand a buyer back a session Stripe will no longer accept. Still
 * comfortably above Stripe's own 30-minute minimum for `expires_at`.
 */
export const CHECKOUT_SESSION_EXPIRY_SEC = PENDING_CHECKOUT_TTL_SEC - 60 * 10;
/** Delayed payment methods (e.g. bank debits) can take several days to settle. */
export const PROCESSING_TTL_SEC = 60 * 60 * 24 * 14;
/** How long a failed/expired checkout's terminal status stays visible to a polling client. */
const TERMINAL_TTL_SEC = 60 * 60;
/**
 * How long a `POST /checkout` reservation holds the (user, plan) slot before a real session id
 * replaces it. Sized to outlast `ensureStripeCustomer` plus `checkout.sessions.create` at the
 * Stripe client's worst case (`STRIPE_TIMEOUT_MS` x (1 + `STRIPE_MAX_NETWORK_RETRIES`) per call,
 * see lib/constants.ts) - but correctness doesn't depend on it: `savePendingCheckout` only replaces a
 * reservation it still holds. If the request dies mid-way, the slot frees itself after this long.
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

// writes the entry and points the (user, plan) slot at it, but only if the slot still holds the
// caller's reservation - one step, so nothing can take the slot between the check and the write
const SAVE_IF_RESERVED = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[2], ARGV[3], "EX", ARGV[4])
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[4])
return 1
`;

/**
 * @description Stores a new checkout's pending entry and points its (user, plan) slot at it.
 * @param reservation the token from `reservePendingCheckout`, for a slot-guarded (non-repeatable)
 * checkout: the save then only happens if the slot still holds it. A reservation can lapse
 * (`RESERVATION_TTL_SEC`) while Stripe is slow, and another request can claim the freed slot -
 * a plain write would then clobber that request's pointer and leave two payable sessions for a
 * plan the user may only buy once. Without one, the slot is overwritten unconditionally.
 * @returns false if the reservation was given and no longer held the slot (nothing was written).
 */
export async function savePendingCheckout(
  sessionId: string,
  data: PendingCheckout,
  ttlSec: number,
  reservation?: string,
): Promise<boolean> {
  if (reservation === undefined) {
    await redis.set(key(sessionId), JSON.stringify(data), "EX", ttlSec);
    await setPointer(data.userId, data.planId, sessionId, ttlSec);
    return true;
  }
  const saved = await redis.send("EVAL", [
    SAVE_IF_RESERVED,
    "2",
    pointerKey(data.userId, data.planId),
    key(sessionId),
    reservation,
    sessionId,
    JSON.stringify(data),
    String(ttlSec),
  ]);
  return saved === 1;
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
 * @description The user's still-open checkout for this plan, if one holds the (user, plan) slot -
 * so `POST /checkout` can send a buyer who closed the Stripe tab back to the same session rather
 * than refusing them until it expires (up to `PENDING_CHECKOUT_TTL_SEC`). Only an `open` session
 * is resumable: a `processing` one is already paid and settling, and an in-flight reservation has
 * no session yet - both still hold the slot.
 * @returns The session id and its Stripe-hosted URL, or null if there's nothing to resume.
 */
export async function getResumableCheckout(
  userId: string,
  planId: number,
): Promise<{ sessionId: string; url: string } | null> {
  const current = await redis.get(pointerKey(userId, planId));
  if (!current || current.startsWith(RESERVATION_PREFIX)) return null;
  const pending = await getPendingCheckout(current);
  if (pending?.status !== "open" || pending.userId !== userId || !pending.url) return null;
  return { sessionId: current, url: pending.url };
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

const createLockKey = (userId: string, planId: number) =>
  `checkout:creating:${userId}:${planId}`;

/**
 * @description Claims the right to create a checkout for a *repeatable* plan, so one (user, plan)
 * only ever has one creation in flight. A repeatable plan has no reservation (buying it again is
 * allowed, and a settling `processing` purchase mustn't block the next one), so without this a
 * burst of concurrent `POST /checkout` calls would each create a Stripe session - every account
 * spending the Stripe API rate limit that the webhook handler shares. Sequential calls already
 * reuse the open session (`getResumableCheckout`); this covers the concurrent ones.
 * @returns A token for `releaseCreateLock`, or null if another creation holds the lock.
 */
export async function acquireCreateLock(
  userId: string,
  planId: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const claimed = await redis.send("SET", [
    createLockKey(userId, planId),
    token,
    "NX",
    "EX",
    String(RESERVATION_TTL_SEC),
  ]);
  return claimed === "OK" ? token : null;
}

/** @description Frees `acquireCreateLock`'s lock, if it still holds this token. */
export async function releaseCreateLock(
  userId: string,
  planId: number,
  token: string,
): Promise<void> {
  await delIfEquals(createLockKey(userId, planId), token);
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

// the rank check and the write happen in one step: as a separate read then write, two events
// for the same session landing together could both read the old status and the lower-ranked one
// could write last, moving the status backward. Returns the entry as it was before (to know whose
// pointer to touch), or nil if there's no entry or the move would go backward.
const TRANSITION = `
local raw = redis.call("GET", KEYS[1])
if not raw then return false end
local rank = { ${Object.entries(STATUS_RANK)
  .map(([status, rank]) => `${status} = ${rank}`)
  .join(", ")} }
local pending = cjson.decode(raw)
if rank[ARGV[1]] < (rank[pending.status] or 0) then return false end
pending.status = ARGV[1]
redis.call("SET", KEYS[1], cjson.encode(pending), "EX", ARGV[2])
return raw
`;

// what a transition does to the (user, plan) pointer: `extend` keeps it alive as long as the
// session's own entry (still holding the slot), `clear` frees the slot (terminal status)
type PointerAction = "extend" | "clear";

async function transition(
  sessionId: string,
  status: PendingCheckout["status"],
  ttlSec: number,
  pointer: PointerAction,
): Promise<boolean> {
  // writes the status directly, unlike savePendingCheckout, which would also repoint the
  // (user, plan) pointer at this session - a retried transition for an old, superseded
  // session must never drag the pointer back off a newer session that's since taken it over
  // (extendPointer/clearPointerIfMatches both leave a newer session's pointer alone)
  const previous = await redis.send("EVAL", [
    TRANSITION,
    "1",
    key(sessionId),
    status,
    String(ttlSec),
  ]);
  if (typeof previous !== "string") return false;
  const pending = JSON.parse(previous) as PendingCheckout;

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

/**
 * Thrown by `createCheckout` when its reservation no longer held the (user, plan) slot by the time
 * the session existed - another checkout for the same plan holds it instead.
 */
export class CheckoutSlotLostError extends Error {
  constructor() {
    super("Checkout reservation lapsed; another checkout holds the slot");
    this.name = "CheckoutSlotLostError";
  }
}
