import { plan, purchase, paymentAuditLog } from "@d/schemas/payment-schema";
import {
  createInsertSchema,
  createUpdateSchema,
  createSelectSchema,
} from "drizzle-zod";
import { z } from "zod";
import {
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
  PURCHASES_DEFAULT_LIMIT,
  PURCHASES_MAX_LIMIT,
  MAX_DURATION_DAYS,
  MAX_TRIAL_DAYS,
} from "@f/payments/lib/constants";

export const insertPlanSchema = createInsertSchema(plan, {
  amount: (s) => s.positive(),
  annualAmount: (s) => s.positive(),
  trialDays: (s) => s.positive().max(MAX_TRIAL_DAYS),
  durationDays: (s) => s.positive().max(MAX_DURATION_DAYS),
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
  )
  .refine((data) => data.type !== "recurring" || data.durationDays == null, {
    message:
      "Recurring plans can't have a duration; access is governed by the Stripe subscription period.",
    path: ["durationDays"],
  });
export const updatePlanSchema = createUpdateSchema(plan, {
  trialDays: (s) => s.positive().max(MAX_TRIAL_DAYS),
  durationDays: (s) => s.positive().max(MAX_DURATION_DAYS),
})
  // allow-list, not a deny-list, of the Stripe-independent policy fields a plan's
  // pricing/identity (name, type, amount, interval, Stripe ids, ...) stays out of this
  .pick({
    limits: true,
    active: true,
    repeatable: true,
    durationDays: true,
    overlapping: true,
    trialDays: true,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided.",
  });
export const selectPlanSchema = createSelectSchema(plan);

export const insertPurchaseSchema = createInsertSchema(purchase).omit({
  userId: true,
  status: true,
  amountRefunded: true,
  expiresAt: true,
  durationDays: true,
  overlapping: true,
  createdAt: true,
  updatedAt: true,
});
export const updatePurchaseSchema = createUpdateSchema(purchase).pick({
  status: true,
  amountRefunded: true,
});
export const selectPurchaseSchema = createSelectSchema(purchase);

// GET /audit-log's query string - every value arrives as a string, hence the coercion
export const auditLogQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_LOG_MAX_LIMIT).default(AUDIT_LOG_DEFAULT_LIMIT),
  before: z.coerce.number().int().positive().optional(),
});

// GET /purchases/all's query string - same shape as auditLogQuerySchema, kept separate since
// these are different resources that may reasonably want different limits later
export const purchasesQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PURCHASES_MAX_LIMIT).default(PURCHASES_DEFAULT_LIMIT),
  before: z.coerce.number().int().positive().optional(),
});

export const checkoutSchema = z.object({
  planId: z.number().int().positive(),
});

export const insertPaymentAuditLogSchema = createInsertSchema(
  paymentAuditLog,
).omit({ createdAt: true });
export const selectPaymentAuditLogSchema = createSelectSchema(paymentAuditLog);
