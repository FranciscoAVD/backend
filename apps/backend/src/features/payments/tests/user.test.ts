import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@backend/d/connection";
import { user as userTable } from "@backend/d/schemas/auth-schema";
import { resetDb, seedUser } from "@backend/test-helpers/db";
import {
  getEmailVerified,
  getForCustomer,
  setStripeCustomerId,
} from "@backend/f/payments/use-cases/user";

describe("getEmailVerified", () => {
  beforeEach(resetDb);

  test("returns the flag for an existing user", async () => {
    const userId = await seedUser({ emailVerified: true });
    expect(await getEmailVerified({ userId })).toEqual({ emailVerified: true });
  });

  test("returns null for a nonexistent user", async () => {
    expect(await getEmailVerified({ userId: "nonexistent" })).toBeNull();
  });
});

describe("getForCustomer", () => {
  beforeEach(resetDb);

  test("returns the user's Stripe customer id", async () => {
    const userId = await seedUser({ stripeCustomerId: "cus_1" });
    expect(await getForCustomer({ userId })).toEqual({ stripeCustomerId: "cus_1" });
  });

  test("returns null stripeCustomerId when the user has none", async () => {
    const userId = await seedUser({ stripeCustomerId: null });
    expect(await getForCustomer({ userId })).toEqual({ stripeCustomerId: null });
  });

  test("returns null for a nonexistent user", async () => {
    expect(await getForCustomer({ userId: "nonexistent" })).toBeNull();
  });
});

describe("setStripeCustomerId", () => {
  beforeEach(resetDb);

  test("writes the customer id", async () => {
    const userId = await seedUser({ stripeCustomerId: null });

    await setStripeCustomerId({ userId }, "cus_new");

    const [row] = await db.select().from(userTable).where(eq(userTable.id, userId));
    expect(row?.stripeCustomerId).toBe("cus_new");
  });
});
