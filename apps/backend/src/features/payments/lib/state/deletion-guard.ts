import { redis } from "@backend/lib/redis";

/**
 * Closes the window between the user-deletion hook's checkout-expiry pass and the user row actually
 * being deleted. The user's session stays valid throughout, so without this a `POST /checkout` or
 * `/subscription/upgrade` landing in that window creates a Checkout Session nothing will expire -
 * and a paid subscription session then bills a user who no longer exists.
 *
 * The deletion hook raises a flag *before* it lists the user's open sessions. Every checkout path
 * checks the flag before creating a session (to fail fast) and again after (to close the race):
 * a creator whose after-check misses the flag created its session before the flag was raised, so
 * before the expiry pass listed sessions, which therefore sees and expires it; a creator whose
 * after-check sees the flag expires its own session. Either way nothing is left open.
 */
export const DELETING_TTL_SEC = 60 * 15;

const key = (userId: string) => `payments:deleting:${userId}`;

/**
 * @description Raises the flag. Left to expire on its own after a successful deletion - an
 * in-flight checkout still needs to see it for its after-check.
 */
export async function markUserDeleting(userId: string): Promise<void> {
  await redis.set(key(userId), "1", "EX", DELETING_TTL_SEC);
}

/** @description Lowers the flag, for a deletion that was aborted. */
export async function clearUserDeleting(userId: string): Promise<void> {
  await redis.del(key(userId));
}

export async function isUserDeleting(userId: string): Promise<boolean> {
  return (await redis.get(key(userId))) !== null;
}
