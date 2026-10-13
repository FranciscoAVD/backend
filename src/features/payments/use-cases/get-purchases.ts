import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { isPurchaseAccessActive } from "@f/payments/lib/utils";
import { eq, and, ne, asc, desc, lt, inArray } from "drizzle-orm";
import {
  PURCHASE_ACCESS_STATUSES,
  PURCHASE_BLOCKING_STATUSES,
} from "@f/payments/lib/access-policy";
import {
  PURCHASES_DEFAULT_LIMIT,
  PURCHASES_MAX_LIMIT,
} from "@f/payments/lib/constants";

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
 * One page of GET /purchases/all, newest first. `before` is the id of the last entry on the
 * previous page (keyset pagination: stable while new purchases keep arriving, unlike an offset) -
 * same approach as `get-audit-log.ts`'s `AuditLogPage`, kept as its own type since these are
 * different resources that may reasonably want different limits later.
 */
export type PurchasePage = { limit?: number; before?: Payment.Purchase["id"] };

// ids are generated in insertion order, so ordering by id is ordering by recency - and unlike
// createdAt it's unique, which keyset pagination needs to never skip or repeat a row
const page = ({ limit = PURCHASES_DEFAULT_LIMIT, before }: PurchasePage) => ({
  limit: Math.min(Math.max(limit, 1), PURCHASES_MAX_LIMIT + 1),
  before: before === undefined ? undefined : lt(purchaseTable.id, before),
});

/**
 * @description Select query for one page of every purchase, most recent first - for an admin
 * reviewing purchases across every customer, not one in particular. Assumes validation.
 * Operation must be wrapped in try-catch
 * @param pageOptions optional page size and cursor, see PurchasePage (the size is capped at
 * PURCHASES_MAX_LIMIT + 1, so a caller can ask for one extra row to tell whether a next page exists)
 * @returns Array of Purchases.
 */
export async function getAllPurchasesAdmin(
  pageOptions: PurchasePage = {},
): Promise<Payment.Purchase[]> {
  const { limit, before } = page(pageOptions);
  return db
    .select()
    .from(purchaseTable)
    .where(before)
    .orderBy(desc(purchaseTable.id))
    .limit(limit);
}

/**
 * @description Select query for one page of a given user's purchases, most recent first - the
 * admin-facing, paginated counterpart to `getAllPurchases` (which returns everything, unpaginated,
 * for the caller's own `GET /purchases`). Assumes validation. Operation must be wrapped in try-catch
 * @param target object of the user ID to look up
 * @param pageOptions optional page size and cursor, see PurchasePage and getAllPurchasesAdmin
 * @returns Array of Purchases.
 */
export async function getPurchasesByUserAdmin(
  target: { userId: string },
  pageOptions: PurchasePage = {},
): Promise<Payment.Purchase[]> {
  const { limit, before } = page(pageOptions);
  return db
    .select()
    .from(purchaseTable)
    .where(and(eq(purchaseTable.userId, target.userId), before))
    .orderBy(desc(purchaseTable.id))
    .limit(limit);
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
        inArray(purchaseTable.status, PURCHASE_BLOCKING_STATUSES),
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
        inArray(purchaseTable.status, PURCHASE_BLOCKING_STATUSES),
      ),
    )
    .limit(1);
  return res.length > 0;
}

/**
 * @description Whether the user currently has active (non-expired) access to the given plan, from
 * their purchases with an access-granting status (`PURCHASE_ACCESS_STATUSES`). How `overlapping`
 * windows are read is `isPurchaseAccessActive`'s job (lib/utils.ts). Assumes validation.
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
        inArray(purchaseTable.status, PURCHASE_ACCESS_STATUSES),
      ),
    )
    .orderBy(asc(purchaseTable.createdAt));

  return isPurchaseAccessActive(purchases, plan, new Date());
}
