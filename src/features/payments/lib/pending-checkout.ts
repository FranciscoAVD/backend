import { redis } from "@/lib/redis";
import type { Payment } from "@f/payments/lib/types";

/**
 * @description An in-flight one-time checkout. Lives in Redis until Stripe confirms
 * the payment; only then is a `purchase` row written to the DB.
 */
export type PendingCheckout = {
  userID: Payment.Purchase["userID"];
  planID: Payment.Plan["id"];
  status: "open" | "processing";
};

/** Matches the Checkout Session `expires_at` set in `createCheckout`. */
export const PENDING_CHECKOUT_TTL_SEC = 60 * 60 * 24;
/** Delayed payment methods (e.g. bank debits) can take several days to settle. */
const PROCESSING_TTL_SEC = 60 * 60 * 24 * 14;

const key = (sessionId: string) => `checkout:${sessionId}`;

export async function savePendingCheckout(
  sessionId: string,
  data: PendingCheckout,
  ttlSec: number,
): Promise<void> {
  await redis.set(key(sessionId), JSON.stringify(data), "EX", ttlSec);
}

export async function getPendingCheckout(
  sessionId: string,
): Promise<PendingCheckout | null> {
  const value = await redis.get(key(sessionId));
  return value ? (JSON.parse(value) as PendingCheckout) : null;
}

/**
 * @description Marks a checkout as paid-but-unsettled and extends its TTL.
 * @returns false if there was no pending entry to update.
 */
export async function markProcessing(sessionId: string): Promise<boolean> {
  const pending = await getPendingCheckout(sessionId);
  if (!pending) return false;
  await savePendingCheckout(
    sessionId,
    { ...pending, status: "processing" },
    PROCESSING_TTL_SEC,
  );
  return true;
}

export async function removePendingCheckout(sessionId: string): Promise<void> {
  await redis.del(key(sessionId));
}
