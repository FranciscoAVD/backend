import { db } from "@d/connection";
import { user, subscription } from "@d/schemas/auth-schema";
import { plan, checkout } from "@d/schemas/payment-schema";
import { sql } from "drizzle-orm";
import { assertTestDatabaseName } from "@/test-helpers/guard";

// checked once per process: the connection's database can't change under it
let verified: Promise<void> | undefined;
const verifyTestDatabase = () =>
  (verified ??= (async () => {
    const res = await db.execute<{ name: string }>(sql`select current_database() as name`);
    assertTestDatabaseName(String(res[0]?.name));
  })());

/**
 * @description Empties every table these tests touch, for isolation between tests.
 * Refuses (throws) unless connected to a database whose name ends in `_test` - see
 * `test-helpers/guard.ts` for why that's checked on the live connection.
 * `subscription` has no FK back to `user` (better-auth keys it by a plain `referenceId` string),
 * so it needs listing explicitly - `user`'s CASCADE alone won't reach it.
 */
export async function resetDb(): Promise<void> {
  await verifyTestDatabase();
  await db.execute(
    sql`TRUNCATE TABLE "user", todo, plan, purchase, checkout, payment_audit_log, subscription RESTART IDENTITY CASCADE`,
  );
}

/**
 * @description Inserts a minimal valid `subscription` row directly, bypassing Stripe and the
 * better-auth plugin entirely - these tests only need a row matching the shape
 * `hasActiveSubscription` queries, not a real Stripe-backed subscription.
 */
export async function seedSubscription(
  overrides: Partial<typeof subscription.$inferInsert> & {
    referenceId: string;
    plan: string;
  },
): Promise<typeof subscription.$inferSelect> {
  const [row] = await db
    .insert(subscription)
    .values({
      id: crypto.randomUUID(),
      status: "active",
      ...overrides,
    })
    .returning();
  return row!;
}

/**
 * @description Inserts a minimal valid `user` row directly, bypassing better-auth entirely —
 * these tests only need a real userId to satisfy FK constraints, not an actual session.
 * @returns The inserted user's id.
 */
export async function seedUser(
  overrides: Partial<typeof user.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({
      id,
      name: "Test User",
      email: `${id}@example.test`,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning();
  return row!.id;
}

/**
 * @description Inserts an in-flight `checkout` row directly, bypassing `POST /checkout` and Stripe
 * entirely — for tests that need a checkout already in a given state rather than one they walked
 * there. Defaults to an `open` session holding slot 1 for the next 24 hours, the shape
 * `createCheckout` leaves behind for a non-repeatable plan.
 */
export async function seedCheckout(
  overrides: Partial<typeof checkout.$inferInsert> & {
    userId: string;
    planId: number;
  },
): Promise<typeof checkout.$inferSelect> {
  const [row] = await db
    .insert(checkout)
    .values({
      status: "open",
      slot: 1,
      url: `https://checkout.stripe.com/c/${overrides.stripeCheckoutSessionId ?? "cs_seeded"}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...overrides,
    })
    .returning();
  return row!;
}

/**
 * @description Inserts a minimal valid `plan` row directly, bypassing Stripe entirely —
 * DB-only use-cases don't care whether the Stripe IDs are real.
 */
export async function seedPlan(
  overrides: Partial<typeof plan.$inferInsert> = {},
): Promise<typeof plan.$inferSelect> {
  const suffix = crypto.randomUUID();
  const [row] = await db
    .insert(plan)
    .values({
      name: `Test Plan ${suffix}`,
      type: "one_time",
      amount: 1000,
      currency: "usd",
      stripeProductId: `prod_${suffix}`,
      stripePriceId: `price_${suffix}`,
      ...overrides,
    })
    .returning();
  return row!;
}
