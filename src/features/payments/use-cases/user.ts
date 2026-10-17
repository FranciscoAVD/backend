import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { eq } from "drizzle-orm";

/**
 * @description Select query for a user's email verification flag. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @returns The flag, or null if no user has that ID.
 */
export async function getEmailVerified(
  target: { userId: string },
): Promise<{ emailVerified: boolean } | null> {
  const res = await db
    .select({ emailVerified: userTable.emailVerified })
    .from(userTable)
    .where(eq(userTable.id, target.userId));
  return res[0] ?? null;
}

/**
 * @description Select query for a user's Stripe customer ID. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @returns The ID (possibly null if none was ever created), or null if no user has that ID.
 */
export async function getForCustomer(
  target: { userId: string },
): Promise<{ stripeCustomerId: string | null } | null> {
  const res = await db
    .select({ stripeCustomerId: userTable.stripeCustomerId })
    .from(userTable)
    .where(eq(userTable.id, target.userId));
  return res[0] ?? null;
}

/**
 * @description Select query for a user's email and name, for the purchase-confirmation email
 * (see `lib/purchase-confirmation-email.ts`) - the DB is this app's authoritative source for user
 * identity, rather than a Stripe checkout session's own (nullable) `customer_details`. Assumes
 * validation. Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @returns The contact fields, or null if no user has that ID.
 */
export async function getContact(
  target: { userId: string },
): Promise<{ email: string; name: string } | null> {
  const res = await db
    .select({ email: userTable.email, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, target.userId));
  return res[0] ?? null;
}

/**
 * @description Update query for a user's Stripe customer ID. A plain write - unlike
 * `services/account.ts`'s `ensureCustomer`, which writes through better-auth's own
 * `internalAdapter.updateUser` instead of this function, because that also refreshes the
 * user's cached session (see that file for why). Kept here for symmetry and any future
 * caller that doesn't need the cache refreshed. Assumes validation. Operation must be
 * wrapped in try-catch
 * @param target object of the user ID to update
 * @param stripeCustomerId the Stripe customer ID to store
 */
export async function setStripeCustomerId(
  target: { userId: string },
  stripeCustomerId: string,
): Promise<void> {
  await db
    .update(userTable)
    .set({ stripeCustomerId })
    .where(eq(userTable.id, target.userId));
}
