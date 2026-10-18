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
export const checkoutStatus = pgEnum("checkout_status", [
  "reserving",
  "open",
  "processing",
  "failed",
  "expired",
  "completed",
]);
export const paymentAuditType = pgEnum("payment_audit_type", [
  // 409 at POST /checkout: a non-repeatable plan is already owned
  "checkout_blocked_existing_purchase",
  // 409 at POST /checkout: another open/processing checkout for the same (user, plan) exists
  "checkout_blocked_pending_checkout",
  // confirmCheckout: money was taken for an already-owned non-repeatable plan (the race the
  // two guards above can't fully close) - still recorded as a purchase; this flags it for review
  "duplicate_purchase_confirmed",
  // POST /purchases/:id/refund: an admin issued a refund through Stripe
  "refund_issued",
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // snapshot of the plan's durationDays at purchase time, so a later edit to the plan
    // doesn't rewrite history for purchases already made (used to re-derive chained windows)
    durationDays: integer("duration_days"),
    // snapshot of the plan's `overlapping` at checkout time: whether this purchase's window runs
    // alongside earlier ones (true) or chains on after them (false). Snapshotted for the same
    // reason as durationDays - flipping the plan's flag later mustn't rewrite access already sold.
    // null on rows written before this column existed, which fall back to the plan's current value
    overlapping: boolean("overlapping"),
    // bumped on every refund/dispute sync write - what that sync's compare-and-set checks, rather
    // than the (status, amountRefunded) pair itself, which can change and change back (a refund
    // applied then reversed) and let a stale write through
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // (user_id, plan_id) serves the per-plan lookups (access checks, the repeat-purchase guard)
  // and, as its leading column, every user_id-only lookup too
  (t) => [index("purchase_user_plan_idx").on(t.userId, t.planId)],
);

// an in-flight one-time checkout, from the moment POST /checkout claims the (user, plan) slot
// until Stripe settles it. A `purchase` row is still only written once the payment confirms;
// this is what that confirmation supersedes, and what keeps a second checkout for a
// non-repeatable plan from being opened in the meantime
export const checkout = pgTable(
  "checkout",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // set null on delete for the same reason `purchase` does it: the row is a record of what
    // happened, and a deletion mid-checkout shouldn't block the delete or erase the trail
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    planId: integer("plan_id")
      .references(() => plan.id)
      .notNull(),
    // null while `reserving` - the slot is claimed before Stripe is called, so there's no
    // session id yet
    stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
    status: checkoutStatus("status").notNull().default("reserving"),
    // the (user, plan) checkout slot this row holds: 1 while a creation is in flight and, for a
    // non-repeatable plan, for the session's whole life; released to null when a repeatable
    // plan's session opens, since buying that again is allowed (nulls never collide in a
    // unique index). Holding it during `reserving` for both plan types is what keeps concurrent
    // POST /checkout calls to one Stripe session per (user, plan)
    slot: integer("slot"),
    // the Stripe-hosted page, so a buyer who closed the tab can be sent back to the same
    // session instead of being locked out until it expires
    url: text("url"),
    // when this row's current status lapses: minutes while `reserving`, the session's own
    // lifetime once `open`, up to four weeks while `processing` (delayed payment methods). A row
    // past this is swept to `expired` by the next claim for the same slot, so a request that
    // died mid-checkout can't hold the slot forever
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // one active checkout per (user, plan) slot. Terminal rows fall outside the predicate, so
  // confirming/failing/expiring a checkout frees the slot by itself. The predicate must stay in
  // lockstep with CHECKOUT_ACTIVE_STATUSES in features/payments/lib/constants.ts
  (t) => [
    uniqueIndex("checkout_active_slot")
      .on(t.userId, t.planId, t.slot)
      .where(sql`status in ('reserving', 'open', 'processing')`),
  ],
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const checkoutRelations = relations(checkout, ({ one }) => ({
  user: one(user, {
    fields: [checkout.userId],
    references: [user.id],
  }),
  plan: one(plan, {
    fields: [checkout.planId],
    references: [plan.id],
  }),
}));
