import { plan, purchase } from "@d/schemas/payment-schema";
import {
  createInsertSchema,
  createUpdateSchema,
  createSelectSchema,
} from "drizzle-zod";
import { z } from "zod";

export const insertPlanSchema = createInsertSchema(plan, {
  amount: (s) => s.positive(),
  annualAmount: (s) => s.positive(),
  trialDays: (s) => s.positive(),
  currency: (s) => s.length(3).toLowerCase(),
})
  .omit({
    stripeProductId: true,
    stripePriceId: true,
    annualDiscountPriceId: true,
    active: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine((data) => data.type !== "recurring" || data.interval != null, {
    message: "Recurring plans require an interval.",
    path: ["interval"],
  })
  .refine(
    (data) =>
      data.type !== "one_time" ||
      (data.interval == null &&
        data.annualAmount == null &&
        data.trialDays == null),
    {
      message:
        "One-time plans can't have an interval, annual amount or trial days.",
      path: ["type"],
    },
  );
export const selectPlanSchema = createSelectSchema(plan);

export const insertPurchaseSchema = createInsertSchema(purchase).omit({
  userID: true,
  status: true,
  amountRefunded: true,
  createdAt: true,
  updatedAt: true,
});
export const updatePurchaseSchema = createUpdateSchema(purchase).pick({
  status: true,
  amountRefunded: true,
});
export const selectPurchaseSchema = createSelectSchema(purchase);

export const checkoutSchema = z.object({
  planID: z.number().int().positive(),
});
