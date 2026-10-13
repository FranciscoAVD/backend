import { db } from "@d/connection";
import { subscription as subscriptionTable } from "@d/schemas/auth-schema";
import type { Subscription } from "@f/payments/use-cases/get-subscription";
import { eq } from "drizzle-orm";

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
  >
>;

/**
 * @description Corrects a subscription row's mutable, Stripe-derived fields - the same set
 * `@better-auth/stripe`'s own webhook handlers write on an update or deletion. Never touches
 * `plan`, `referenceId`, `stripeCustomerId` or `stripeSubscriptionId` itself - identity fields
 * the plugin sets once at creation, which aren't what staleness puts at risk and aren't this
 * reconciler's business to touch. Assumes validation. Operation must be wrapped in try-catch
 * @param subscription object of the caller's own (always real, non-null) Stripe subscription ID -
 * narrowed from the column's nullable type, since the caller only reaches this after already
 * filtering out rows with no Stripe subscription ID at all
 * @param fields the corrected field values
 */
export async function updateSubscriptionFields(
  subscription: { stripeSubscriptionId: string },
  fields: SubscriptionCorrection,
): Promise<void> {
  await db
    .update(subscriptionTable)
    .set(fields)
    .where(eq(subscriptionTable.stripeSubscriptionId, subscription.stripeSubscriptionId));
}
