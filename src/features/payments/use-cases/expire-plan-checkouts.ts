import type Stripe from "stripe";
import type { Payment } from "@f/payments/lib/types";
import { getPaymentProcessor } from "@f/payments/payment";
import { getSubscriptionsByIds } from "@f/payments/use-cases/get-subscription";
import { markExpired } from "@f/payments/lib/pending-checkout";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

/**
 * @description Expires every Checkout Session still open for a plan - run when the plan is retired
 * (per `RETIRING_EXPIRES_OPEN_CHECKOUTS`), since archiving its price stops new checkouts but not ones
 * already created, which stay payable for up to 24h. Covers both kinds: this feature's one-time
 * checkouts carry the plan's id in `metadata.planId`; the stripe plugin's subscription checkouts carry
 * the id of their pending `subscription` row in `metadata.subscriptionId`, whose `plan` names the plan.
 * Sessions from anything else on the account match neither and are left alone. Each expired
 * one-time session's pending entry is marked `expired` right away, so it can't be resumed. Errors propagate - an
 * expiry that fails (including for a session completed at that very moment) fails the whole call -
 * and it's safe to repeat, since an expired or completed session is no longer listed as open.
 * Operation must be wrapped in try-catch
 * @param plan object of the plan's ID, name and type
 * @returns The IDs of the sessions it expired.
 */
export async function expireOpenCheckoutsForPlan(
  plan: Pick<Payment.Plan, "id" | "name" | "type">,
): Promise<string[]> {
  const stripe = getPaymentProcessor();
  const open: Stripe.Checkout.Session[] = [];
  for await (const session of stripe.checkout.sessions.list({ status: "open", limit: 100 }))
    open.push(session);

  let matches: Stripe.Checkout.Session[];
  if (plan.type === "one_time") {
    matches = open.filter((session) => session.metadata?.planId === String(plan.id));
  } else {
    const rowIds = open.flatMap((session) => session.metadata?.subscriptionId ?? []);
    const rows = await getSubscriptionsByIds(rowIds);
    // the plugin stores plan names lowercased, and matches them case-insensitively
    const forThisPlan = new Set(
      rows.filter((row) => row.plan.toLowerCase() === plan.name.toLowerCase()).map((row) => row.id),
    );
    matches = open.filter((session) =>
      forThisPlan.has(session.metadata?.subscriptionId ?? ""),
    );
  }

  const expired: string[] = [];
  for (const session of matches) {
    await stripe.checkout.sessions.expire(session.id);
    expired.push(session.id);
    // marked expired here too, not only once checkout.session.expired arrives: until then the
    // pending entry still says `open`, and POST /checkout's resume path would hand the buyer this
    // now-dead session's URL instead of a new one. Frees the (user, plan) slot the same way the
    // webhook would. Best-effort - the webhook still does it if this fails, and a subscription
    // checkout has no pending entry, so this is a no-op for those
    const [, markError] = await tryCatch(markExpired(session.id));
    if (markError)
      logger.warn({ err: markError, session: session.id }, "payments.plan.mark_expired");
  }
  return expired;
}
