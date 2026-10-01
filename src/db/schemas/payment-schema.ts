import { relations } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  integer,
  timestamp,
  boolean,
  index,
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
  stripeProductId: text("stripe_product_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull().unique(),
  annualDiscountPriceId: text("annual_discount_price_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const purchase = pgTable(
  "purchase",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userID: text("user_id")
      .references(() => user.id)
      .notNull(),
    planID: integer("plan_id")
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
    amountRefunded: integer("amount_refunded").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("purchase_user_idx").on(t.userID)],
);

export const planRelations = relations(plan, ({ many }) => ({
  purchases: many(purchase),
}));

export const purchaseRelations = relations(purchase, ({ one }) => ({
  user: one(user, {
    fields: [purchase.userID],
    references: [user.id],
  }),
  plan: one(plan, {
    fields: [purchase.planID],
    references: [plan.id],
  }),
}));
