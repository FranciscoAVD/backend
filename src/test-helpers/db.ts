import { db } from "@d/connection";
import { user } from "@d/schemas/auth-schema";
import { plan } from "@d/schemas/payment-schema";
import { sql } from "drizzle-orm";

/**
 * @description Empties every table these tests touch, for isolation between tests.
 * Must only ever run against the `backend_test` database (`bun run test`, never bare `bun test`).
 */
export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE "user", todo, plan, purchase RESTART IDENTITY CASCADE`,
  );
}

/**
 * @description Inserts a minimal valid `user` row directly, bypassing better-auth entirely —
 * these tests only need a real userID to satisfy FK constraints, not an actual session.
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
