import { db } from "@d/connection";
import { plan as planTable } from "@d/schemas/payment-schema";
import type { Payment } from "@f/payments/lib/types";
import { payment } from "@f/payments/payment";
import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";

/**
 * @description Creates the Stripe product and price(s) for a plan, then inserts the plan.
 * If anything after the product creation fails, the Stripe product is archived so it
 * doesn't linger without a DB row. Assumes validation. Operation must be wrapped in try-catch
 * @param plan object of insert fields enforced by Payment.Plan.Insert
 * @returns Plan object or null. If null, the insert didn't return a row.
 */
export async function addPlan(
  plan: Payment.Plan.Insert,
): Promise<Payment.Plan | null> {
  const product = await payment.products.create({ name: plan.name });

  try {
    const price = await payment.prices.create({
      product: product.id,
      currency: plan.currency,
      unit_amount: plan.amount,
      ...(plan.type === "recurring" && plan.interval
        ? { recurring: { interval: plan.interval } }
        : {}),
    });

    const annualPrice = plan.annualAmount
      ? await payment.prices.create({
          product: product.id,
          currency: plan.currency,
          unit_amount: plan.annualAmount,
          recurring: { interval: "year" },
        })
      : null;

    const res = await db
      .insert(planTable)
      .values({
        ...plan,
        stripeProductId: product.id,
        stripePriceId: price.id,
        annualDiscountPriceId: annualPrice?.id ?? null,
      })
      .returning();
    return res[0] ?? null;
  } catch (e) {
    const [, archiveError] = await tryCatch(
      payment.products.update(product.id, { active: false }),
    );
    if (archiveError)
      logger.warn(
        { err: archiveError, product: product.id },
        "payments.plan.archive",
      );
    throw e;
  }
}
