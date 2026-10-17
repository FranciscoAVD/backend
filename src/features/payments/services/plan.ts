import type Stripe from "stripe";
import type { Payment } from "@f/payments/lib/types";
import { paymentsRepo } from "@f/payments/repo";
import { getPaymentProcessor } from "@f/payments/lib/stripe/client";
import { markExpired } from "@f/payments/services/checkout";
import { isUniqueViolation } from "@f/payments/lib/utils";
import {
  RETIRED_PLANS_KEEP_ACCESS,
  RETIRING_EXPIRES_OPEN_CHECKOUTS,
} from "@f/payments/lib/access-policy";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

export type PlanCreateResult =
  | { kind: "created"; plan: Payment.Plan }
  | { kind: "duplicate_name" };

/**
 * @description Creates the Stripe product and price(s) for a plan, then inserts the plan row -
 * checking for a name collision first so a duplicate doesn't create an orphan Stripe product, and
 * again via the database's case-insensitive unique index (which settles a race the pre-check
 * can't), archiving the Stripe product it made if either the insert or the race-check fails.
 * Operation must be wrapped in try-catch
 */
export async function create(data: Payment.Plan.Insert): Promise<PlanCreateResult> {
  const existing = await paymentsRepo.plan.get.byName({ name: data.name });
  if (existing) return { kind: "duplicate_name" };

  const stripe = getPaymentProcessor();
  const product = await stripe.products.create({ name: data.name });

  try {
    const price = await stripe.prices.create({
      product: product.id,
      currency: data.currency,
      unit_amount: data.amount,
      ...(data.type === "recurring" && data.interval
        ? { recurring: { interval: data.interval } }
        : {}),
    });

    const annualPrice = data.annualAmount
      ? await stripe.prices.create({
          product: product.id,
          currency: data.currency,
          unit_amount: data.annualAmount,
          recurring: { interval: "year" },
        })
      : null;

    const plan = await paymentsRepo.plan.add({
      ...data,
      stripeProductId: product.id,
      stripePriceId: price.id,
      annualDiscountPriceId: annualPrice?.id ?? null,
    });
    if (!plan) throw new Error("Could not create plan");
    return { kind: "created", plan };
  } catch (e) {
    const [, archiveError] = await tryCatch(stripe.products.update(product.id, { active: false }));
    if (archiveError)
      logger.warn({ err: archiveError, product: product.id }, "payments.plan.archive");
    // the pre-check above can race another create of the same name, or one differing only in
    // case; the database's case-insensitive unique index is what settles it
    if (isUniqueViolation(e)) return { kind: "duplicate_name" };
    throw e;
  }
}

/**
 * @description Mirrors a plan's `active` flag onto its Stripe price(s): retiring a plan archives
 * them, reactivating restores them. Idempotent, so a failed sync is retried by repeating the same
 * edit.
 */
async function syncPlanPricesActive(
  plan: Pick<Payment.Plan, "active" | "stripePriceId" | "annualDiscountPriceId">,
): Promise<void> {
  const stripe = getPaymentProcessor();
  for (const priceId of [plan.stripePriceId, plan.annualDiscountPriceId]) {
    if (priceId) await stripe.prices.update(priceId, { active: plan.active });
  }
}

/**
 * @description Expires every Checkout Session still open for a plan - run when the plan is
 * retired, since archiving its price stops new checkouts but not ones already created, which stay
 * payable for up to 24h. Covers both one-time checkouts (plan id in `metadata.planId`) and
 * subscription checkouts (the stripe plugin's pending `subscription` row, whose `plan` names the
 * plan). Each expired one-time session's checkout row is marked `expired` right away.
 */
async function expireOpenCheckoutsForPlan(
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
    const rows = await paymentsRepo.subscription.getByIds(rowIds);
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
    const [, markError] = await tryCatch(markExpired(session.id));
    if (markError)
      logger.warn({ err: markError, session: session.id }, "payments.plan.mark_expired");
  }
  return expired;
}

export type PlanUpdateResult =
  | { kind: "not_found" }
  | { kind: "invalid_field"; message: string }
  | { kind: "repeat_blocked" }
  | { kind: "updated"; plan: Payment.Plan }
  | { kind: "updated_sync_failed"; plan: Payment.Plan; message: string }
  | { kind: "updated_expire_failed"; plan: Payment.Plan; message: string };

/**
 * @description Updates a plan: validates `durationDays`/`trialDays` only apply to their matching
 * plan type, blocks flipping `repeatable` to true if a blocking purchase exists, then conditionally
 * syncs the plan's Stripe prices and expires open checkouts (retiring/reactivating, or terms
 * changing). Operation must be wrapped in try-catch
 */
export async function update(
  target: Pick<Payment.Plan, "id">,
  data: Payment.Plan.Update,
): Promise<PlanUpdateResult> {
  if (data.repeatable === true || data.durationDays != null || data.trialDays != null) {
    const plan = await paymentsRepo.plan.get.one(target);
    if (!plan) return { kind: "not_found" };

    if (data.durationDays != null && plan.type !== "one_time")
      return { kind: "invalid_field", message: "durationDays only applies to one-time plans" };

    if (data.trialDays != null && plan.type !== "recurring")
      return { kind: "invalid_field", message: "trialDays only applies to recurring plans" };

    if (data.repeatable === true && plan.type === "one_time" && !plan.repeatable) {
      const blocked = await paymentsRepo.purchase.hasAnyBlocking({ planId: target.id });
      if (blocked) return { kind: "repeat_blocked" };
    }
  }

  // the terms a checkout snapshots onto its session: if either changes, sessions already open
  // keep selling the old terms for up to 24h, so they're expired below
  const touchesTerms = data.durationDays !== undefined || data.overlapping !== undefined;

  const res = await paymentsRepo.plan.update(target, data);
  if (!res) return { kind: "not_found" };

  if (data.active !== undefined) {
    const [, syncError] = await tryCatch(
      (async () => {
        await syncPlanPricesActive(res);
        if (!res.active && RETIRING_EXPIRES_OPEN_CHECKOUTS) await expireOpenCheckoutsForPlan(res);
      })(),
    );
    if (syncError) {
      logger.error({ err: syncError, plan: res.id }, "payments.plan.sync_prices");
      return {
        kind: "updated_sync_failed",
        plan: res,
        message: "Plan updated, but Stripe couldn't be fully updated. Retry the same change.",
      };
    }
  }

  if (touchesTerms && res.type === "one_time" && res.active) {
    const [, expireError] = await tryCatch(expireOpenCheckoutsForPlan(res));
    if (expireError) {
      logger.error({ err: expireError, plan: res.id }, "payments.plan.expire_stale_checkouts");
      return {
        kind: "updated_expire_failed",
        plan: res,
        message:
          "Plan updated, but checkouts opened under the old terms couldn't all be closed. Retry the same change.",
      };
    }
  }

  return { kind: "updated", plan: res };
}

/**
 * @description Whether the user currently has access to a plan - one_time via purchases,
 * recurring via better-auth's subscription table - applying the `RETIRED_PLANS_KEEP_ACCESS`
 * policy. Operation must be wrapped in try-catch
 * @returns null if the plan doesn't exist.
 */
export async function access(
  target: { userId: string; planId: number },
): Promise<{ active: boolean; planActive: boolean } | null> {
  const plan = await paymentsRepo.plan.get.one({ id: target.planId });
  if (!plan) return null;

  const active =
    plan.type === "one_time"
      ? await paymentsRepo.purchase.hasActive(
          { userId: target.userId, planId: plan.id },
          { overlapping: plan.overlapping },
        )
      : await paymentsRepo.subscription.hasActive({ userId: target.userId }, { name: plan.name });

  const holds = active && (plan.active || RETIRED_PLANS_KEEP_ACCESS);
  return { active: holds, planActive: plan.active };
}
