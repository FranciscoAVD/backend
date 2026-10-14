import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  varchar,
  text,
  jsonb,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const planType = pgEnum("plan_type", ["recurring", "one_time"]);
export const planInterval = pgEnum("plan_interval", ["month", "year"]);
export const purchaseStatus = pgEnum("purchase_status", [
  "paid",
  "refunded",
  "disputed",
]);
export const paymentAuditType = pgEnum("payment_audit_type", [
  // 409 at POST /checkout: a non-repeatable plan is already owned
  "checkout_blocked_existing_purchase",
  // 409 at POST /checkout: another open/processing checkout for the same (user, plan) exists
  "checkout_blocked_pending_checkout",
  // confirmCheckout: money was taken for an already-owned non-repeatable plan (the race the
  // two guards above can't fully close) - still recorded as a purchase; this flags it for review
  "duplicate_purchase_confirmed",
]);

export const plan = pgTable("plan", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // better-auth's stripe plugin looks subscription plans up by name
  name: varchar("name", { length: 50 }).notNull().unique(),
  type: planType("type").notNull(),
  // minor units (e.g. cents)
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  interval: planInterval("interval"),
  annualAmount: integer("annual_amount"),
  trialDays: integer("trial_days"),
  limits: jsonb("limits").$type<Record<string, unknown>>(),
  // one-time plans only: whether the same user can buy this plan more than once
  repeatable: boolean("repeatable").notNull().default(false),
  // one-time plans only: days of access a purchase grants from its own createdAt,
  // independent of any other purchase of the same plan; null means it never expires
  durationDays: integer("duration_days"),
  // only meaningful when repeatable + durationDays are both set: whether a second purchase's
  // access window can run concurrently with an unexpired one, or must instead chain on after it
  overlapping: boolean("overlapping").notNull().default(true),
  stripeProductId: text("stripe_product_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull().unique(),
  annualDiscountPriceId: text("annual_discount_price_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
},
  // unique case-insensitively, not just as written: the stripe plugin and every subscription lookup
  // here match plan names case-insensitively, so "Pro" and "pro" side by side would make one
  // subscription grant both plans. POST /plans checks this too, but only this closes the race
  (t) => [uniqueIndex("plan_name_lower_idx").on(sql`lower(${t.name})`)],
);

export const purchase = pgTable(
  "purchase",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // nullable + set null on delete, unlike todo's cascade: a purchase is a
    // financial record that should outlive the user it's attached to, not
    // disappear (or block deletion) when they're removed
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    planId: integer("plan_id")
      .references(() => plan.id)
      .notNull(),
    status: purchaseStatus("status").notNull().default("paid"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id")
      .notNull()
      .unique(),
    // null when the session total was 0 (Stripe creates no payment intent)
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    // minor units (e.g. cents)
    amountTotal: integer("amount_total").notNull(),
    // money returned to the customer: refunds, plus a lost chargeback's disputed amount (minor units)
    amountRefunded: integer("amount_refunded").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull(),
    // from the plan's durationDays at the time of purchase; null means it never expires.
    // Each purchase's window is independent, so two purchases of the same plan can overlap.
    expiresAt: timestamp("expires_at"),
    // snapshot of the plan's durationDays at purchase time, so a later edit to the plan
    // doesn't rewrite history for purchases already made (used to re-derive chained windows)
    durationDays: integer("duration_days"),
    // snapshot of the plan's `overlapping` at checkout time: whether this purchase's window runs
    // alongside earlier ones (true) or chains on after them (false). Snapshotted for the same
    // reason as durationDays - flipping the plan's flag later mustn't rewrite access already sold.
    // null on rows written before this column existed, which fall back to the plan's current value
    overlapping: boolean("overlapping"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // (user_id, plan_id) serves the per-plan lookups (access checks, the repeat-purchase guard)
  // and, as its leading column, every user_id-only lookup the old single-column index did
  (t) => [index("purchase_user_plan_idx").on(t.userId, t.planId)],
);

// a persistent, queryable trail of the race conditions around `plan.repeatable` - the two
// checkout-blocked cases and the race that can't be fully closed, where money was already taken
// for an already-owned non-repeatable plan and needs a human to review for a possible refund
export const paymentAuditLog = pgTable(
  "payment_audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    type: paymentAuditType("type").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    planId: integer("plan_id").references(() => plan.id, { onDelete: "set null" }),
    existingPurchaseId: integer("existing_purchase_id").references(
      () => purchase.id,
      { onDelete: "set null" },
    ),
    // only set for duplicate_purchase_confirmed
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("payment_audit_log_user_idx").on(t.userId)],
);

export const planRelations = relations(plan, ({ many }) => ({
  purchases: many(purchase),
}));

export const purchaseRelations = relations(purchase, ({ one }) => ({
  user: one(user, {
    fields: [purchase.userId],
    references: [user.id],
  }),
  plan: one(plan, {
    fields: [purchase.planId],
    references: [plan.id],
  }),
}));
