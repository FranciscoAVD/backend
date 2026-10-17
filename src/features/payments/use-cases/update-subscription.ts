import { db } from "@d/connection";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import type { Subscription } from "@f/payments/use-cases/get-subscription";
import { and, eq, isNull, or, sql } from "drizzle-orm";

export type SubscriptionCorrection = Partial<
  Pick<
    Subscription,
    | "status"
    | "periodStart"
    | "periodEnd"
    | "trialStart"
    | "trialEnd"
    | "cancelAtPeriodEnd"
    | "cancelAt"
    | "canceledAt"
    | "endedAt"
    | "plan"
    | "stripeSubscriptionId"
  >
>;

// the fields a correction touches, and so the ones compared against what was read
const CORRECTED_FIELDS = [
  "status",
  "periodStart",
  "periodEnd",
  "trialStart",
  "trialEnd",
  "cancelAtPeriodEnd",
  "cancelAt",
  "canceledAt",
  "endedAt",
  "plan",
] as const satisfies readonly (keyof SubscriptionCorrection)[];

/**
 * @description Corrects a subscription row's mutable, Stripe-derived fields - the same set
 * `@better-auth/stripe`'s own webhook handlers write on an update or deletion, `plan` included
 * (the plugin re-resolves it from the subscription's current price on every
 * `customer.subscription.updated`, so it's just as mutable as status/period). Never touches
 * `referenceId` or `stripeCustomerId` - those genuinely are identity fields the plugin sets once
 * at creation. `stripeSubscriptionId` is only ever filled in, never changed: a row the plugin
 * created but whose checkout webhook failed has none yet (see `services/reconcile.ts`'s
 * `subscriptions`), and one that already has an id only matches if it's still that same id.
 *
 * A compare-and-set: the row is only written if it still holds exactly what the caller read
 * (`expected`). The reconciler's Stripe snapshot is fetched in bulk, and the plugin writes this
 * table straight from each webhook without any lock this code could share - so a webhook that
 * lands between the read and this write may carry newer state (a cancellation, say) than the
 * snapshot, and blindly writing the snapshot would undo it and hand access back. When the row has
 * changed, nothing is written and the next run compares again. Assumes validation. Operation must
 * be wrapped in try-catch
 * @param subscription object of the Stripe subscription this row tracks (always real, non-null) -
 * written onto a row that has none yet
 * @param fields the corrected field values
 * @param expected the row as the caller read it, before deciding on the correction
 * @returns Whether the row was written - false if it changed since `expected` was read.
 */
export async function updateSubscriptionFields(
  subscription: { stripeSubscriptionId: string },
  fields: SubscriptionCorrection,
  expected: Subscription,
): Promise<boolean> {
  const res = await db
    .update(subscriptionTable)
    .set({ ...fields, stripeSubscriptionId: subscription.stripeSubscriptionId })
    .where(
      and(
        eq(subscriptionTable.id, expected.id),
        // a row already tied to a Stripe subscription is never re-pointed at another one
        or(
          eq(subscriptionTable.stripeSubscriptionId, subscription.stripeSubscriptionId),
          isNull(subscriptionTable.stripeSubscriptionId),
        ),
        sql`${subscriptionTable.stripeSubscriptionId} IS NOT DISTINCT FROM ${expected.stripeSubscriptionId}`,
        ...CORRECTED_FIELDS.map(
          (field) => sql`${subscriptionTable[field]} IS NOT DISTINCT FROM ${expected[field]}`,
        ),
      ),
    )
    .returning({ id: subscriptionTable.id });
  return res.length > 0;
}
