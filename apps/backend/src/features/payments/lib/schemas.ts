import {
  plan,
  purchase,
  checkout,
  paymentAuditLog,
} from "@backend/d/schemas/payment-schema";
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
} from "@backend/f/payments/lib/constants";
import { planLimitsSchema } from "@backend/f/payments/lib/plan-limits";

export const insertPlanSchema = createInsertSchema(plan, {
  // NFKC-normalized only: plan names are matched case-insensitively (the stripe plugin with JS's
  // toLowerCase, the unique index with Postgres's lower()), and compatibility characters like the
  // Kelvin sign fold differently in each - normalized, a name can't look distinct to one and
  // identical to the other
  name: (s) =>
    s
      .trim()
      .min(1)
      .refine((name) => name === name.normalize("NFKC"), {
        message: "Plan names must be NFKC-normalized (no compatibility characters).",
      }),
  amount: (s) => s.positive(),
  annualAmount: (s) => s.positive(),
  trialDays: (s) => s.positive().max(MAX_TRIAL_DAYS),
  durationDays: (s) => s.positive().max(MAX_DURATION_DAYS),
  currency: (s) => s.length(3).toLowerCase(),
  // a schema rather than a refinement callback: drizzle-zod's own json schema accepts any JSON
  // value (a string, an array), so the column's TypeScript type was never actually enforced
  limits: planLimitsSchema.nullable().optional(),
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
  limits: planLimitsSchema.nullable().optional(),
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
export const selectPlanSchema = createSelectSchema(plan, {
  limits: planLimitsSchema.nullable(),
});

export const insertPurchaseSchema = createInsertSchema(purchase).omit({
  userId: true,
  status: true,
  amountRefunded: true,
  expiresAt: true,
  durationDays: true,
  overlapping: true,
  version: true,
  createdAt: true,
  updatedAt: true,
});
export const updatePurchaseSchema = createUpdateSchema(purchase).pick({
  status: true,
  amountRefunded: true,
});
export const selectPurchaseSchema = createSelectSchema(purchase);

// a checkout row is never built from client input - `userId`/`status`/`slot` are set by the claim
// itself, so the insert variant only carries what the caller decides
export const insertCheckoutSchema = createInsertSchema(checkout).omit({
  userId: true,
  status: true,
  slot: true,
  stripeCheckoutSessionId: true,
  url: true,
  createdAt: true,
});
// the fields `openCheckout` writes when the reserved row becomes a payable session
export const updateCheckoutSchema = createUpdateSchema(checkout).pick({
  stripeCheckoutSessionId: true,
  url: true,
  slot: true,
  expiresAt: true,
});
export const selectCheckoutSchema = createSelectSchema(checkout);

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

export const refundPurchaseSchema = z.object({
  amount: z.number().int().positive().optional(), // omit for a full refund
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
  // one per refund the caller *means* to issue (e.g. a UUID generated when the refund form opens),
  // reused only to retry that same refund. Deriving the key from (purchase, amount, reason) instead
  // made two genuine, identical partial refunds collapse into one at Stripe while both reported
  // success - only the caller knows whether a second request is a retry or a new refund
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9_:-]+$/, "Letters, digits, '_', ':' and '-' only."),
});

export const insertPaymentAuditLogSchema = createInsertSchema(
  paymentAuditLog,
).omit({ createdAt: true });
export const selectPaymentAuditLogSchema = createSelectSchema(paymentAuditLog);
