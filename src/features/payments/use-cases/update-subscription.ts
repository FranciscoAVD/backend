import { db } from "@d/connection";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import type { Subscription } from "@f/payments/use-cases/get-subscription";
import { and, eq, sql } from "drizzle-orm";

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
 * `referenceId`, `stripeCustomerId` or `stripeSubscriptionId` itself - those genuinely are
 * identity fields the plugin sets once at creation.
 *
 * A compare-and-set: the row is only written if it still holds exactly what the caller read
 * (`expected`). The reconciler's Stripe snapshot is fetched in bulk, and the plugin writes this
 * table straight from each webhook without any lock this code could share - so a webhook that
 * lands between the read and this write may carry newer state (a cancellation, say) than the
 * snapshot, and blindly writing the snapshot would undo it and hand access back. When the row has
 * changed, nothing is written and the next run compares again. Assumes validation. Operation must
 * be wrapped in try-catch
 * @param subscription object of the caller's own (always real, non-null) Stripe subscription ID
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
    .set(fields)
    .where(
      and(
        eq(subscriptionTable.stripeSubscriptionId, subscription.stripeSubscriptionId),
        ...CORRECTED_FIELDS.map(
          (field) => sql`${subscriptionTable[field]} IS NOT DISTINCT FROM ${expected[field]}`,
        ),
      ),
    )
    .returning({ id: subscriptionTable.id });
  return res.length > 0;
}
