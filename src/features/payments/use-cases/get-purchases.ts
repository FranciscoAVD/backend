import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { eq, and, ne, asc, inArray } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @description Select query for all purchases with a matching user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of the caller's own user ID - always a real, live user, unlike a purchase
 * row's own (nullable) userId once that user is deleted
 * @returns Array of Purchases.
 */
export async function getAllPurchases(
  purchase: { userId: string },
): Promise<Payment.Purchase[]> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(eq(purchaseTable.userId, purchase.userId));
  return res;
}

/**
 * @description Select query for purchase with a matching checkout session ID and user ID. Assumes validation. Operation must be wrapped in try-catch
 * @param purchase object of session ID (enforced by Pick<Payment.Purchase, "stripeCheckoutSessionId">)
 * and the caller's own user ID - always a real, live user, unlike a purchase row's own (nullable)
 * userId once that user is deleted
 * @returns Purchase object or null. If null, the checkout hasn't been confirmed (or isn't this user's).
 */
export async function getPurchaseBySession(
  purchase: { userId: string } & Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<Payment.Purchase | null> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(
      and(
        eq(
          purchaseTable.stripeCheckoutSessionId,
          purchase.stripeCheckoutSessionId,
        ),
        eq(purchaseTable.userId, purchase.userId),
      ),
    );
  return res[0] ?? null;
}

/**
 * @description Select query for the purchase recorded for a checkout session, whoever owns it -
 * including a purchase whose user was since deleted (`userId` set null), which the user-scoped
 * `getPurchaseBySession` can't see. For system callers that already know the session is ours
 * (the reconciler), never for a route answering a user. Assumes validation. Operation must be
 * wrapped in try-catch
 * @param purchase object of session ID enforced by Pick<Payment.Purchase, "stripeCheckoutSessionId">
 * @returns Purchase object or null. If null, no purchase is recorded for that session yet.
 */
export async function getPurchaseBySessionAnyUser(
  purchase: Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<Payment.Purchase | null> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(eq(purchaseTable.stripeCheckoutSessionId, purchase.stripeCheckoutSessionId));
  return res[0] ?? null;
}

/**
 * @description Select query for a purchase of the given plan by the given user that should block a
 * repurchase of a plan whose `repeatable` flag is false - `paid` or `disputed` (money is still held
 * either way); only `refunded` frees the slot. `exclude`, when given, leaves out a specific checkout
 * session - `confirmCheckout`'s own re-check uses this so a Stripe redelivery of the same session
 * doesn't find the row its own earlier delivery just wrote and flag it as a duplicate. Assumes
 * validation. Operation must be wrapped in try-catch
 * @param purchase object of the caller's own user ID and the plan ID, enforced by Pick<Payment.Purchase, "planId">
 * @param exclude optional checkout session to leave out of the match, enforced by Pick<Payment.Purchase, "stripeCheckoutSessionId">
 * @returns Purchase object or null. If null, the user has no blocking purchase of that plan yet.
 */
export async function getBlockingPurchaseByPlan(
  purchase: { userId: string } & Pick<Payment.Purchase, "planId">,
  exclude?: Pick<Payment.Purchase, "stripeCheckoutSessionId">,
): Promise<Payment.Purchase | null> {
  const res = await db
    .select()
    .from(purchaseTable)
    .where(
      and(
        eq(purchaseTable.userId, purchase.userId),
        eq(purchaseTable.planId, purchase.planId),
        inArray(purchaseTable.status, ["paid", "disputed"]),
        exclude
          ? ne(purchaseTable.stripeCheckoutSessionId, exclude.stripeCheckoutSessionId)
          : undefined,
      ),
    );
  return res[0] ?? null;
}

/**
 * @description Whether *any* user has a purchase of the given plan that would block a repeat
 * buy - the same `paid`/`disputed` check as `getBlockingPurchaseByPlan`, but across every user
 * rather than one, so `PATCH /plans/:id` can tell whether flipping `repeatable` from `false` to
 * `true` would reopen the plan to someone who was previously locked out of buying it again.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param plan object of the plan ID, enforced by Pick<Payment.Purchase, "planId">
 * @returns Whether a blocking purchase of this plan exists for any user.
 */
export async function hasAnyBlockingPurchase(
  plan: Pick<Payment.Purchase, "planId">,
): Promise<boolean> {
  const res = await db
    .select({ id: purchaseTable.id })
    .from(purchaseTable)
    .where(
      and(
        eq(purchaseTable.planId, plan.planId),
        inArray(purchaseTable.status, ["paid", "disputed"]),
      ),
    )
    .limit(1);
  return res.length > 0;
}

/**
 * @description Whether the user currently has active (non-expired) access to the given plan. Storage
 * never chains purchases - each row's expiresAt comes from its own createdAt + the plan's durationDays
 * at purchase time - so `overlapping` only changes how they're read: `true` treats any one unexpired
 * purchase as enough; `false` chains paid purchases end-to-end in order (gaps included, so a lapse
 * before the next purchase isn't backfilled), recomputing each purchase's end as
 * `(chain-adjusted start) + its own durationDays` rather than trusting its independently-computed,
 * unchained `expiresAt` - a later purchase bought before an earlier one lapses must extend access
 * from where the earlier one ends, not shorten it to its own naive window. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param target object of the caller's own user ID and the plan ID, enforced by Pick<Payment.Purchase, "planId">
 * @param plan object of the plan's overlapping setting, enforced by Pick<Payment.Plan, "overlapping">
 * @returns Whether the user has active access to the plan right now.
 */
export async function hasActivePurchase(
  target: { userId: string } & Pick<Payment.Purchase, "planId">,
  plan: Pick<Payment.Plan, "overlapping">,
): Promise<boolean> {
  const purchases = await db
    .select()
    .from(purchaseTable)
    .where(
      and(
        eq(purchaseTable.userId, target.userId),
        eq(purchaseTable.planId, target.planId),
        eq(purchaseTable.status, "paid"),
      ),
    )
    .orderBy(asc(purchaseTable.createdAt));

  const now = new Date();

  if (plan.overlapping)
    return purchases.some((p) => p.expiresAt === null || p.expiresAt > now);

  let chainEnd: Date | null = null;
  for (const p of purchases) {
    const start: Date = chainEnd && chainEnd > p.createdAt ? chainEnd : p.createdAt;
    if (p.durationDays == null) {
      // no duration snapshot: either a genuinely perpetual purchase (expiresAt also
      // null), or a pre-migration row written before this column existed - either way,
      // trust its own expiresAt rather than treating a null duration as "never expires"
      if (p.expiresAt === null) return true;
      if (now >= start && now < p.expiresAt) return true;
      chainEnd = p.expiresAt;
      continue;
    }
    const end: Date = new Date(start.getTime() + p.durationDays * DAY_MS);
    if (now >= start && now < end) return true;
    chainEnd = end;
  }
  return false;
}
