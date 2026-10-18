import { describe, expect, test, beforeEach } from "bun:test";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { syncPurchaseCharge } from "@f/payments/use-cases/sync-purchase-charge";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import { db } from "@d/connection";
import { purchase as purchaseTable } from "@d/schemas/payment-schema";
import { eq, sql } from "drizzle-orm";

beforeEach(resetDb);

async function seedPurchase(stripePaymentIntentId: string) {
  const userId = await seedUser();
  const plan = await seedPlan();
  await addPurchase(
    { userId },
    {
      planId: plan.id,
      stripeCheckoutSessionId: `cs_${stripePaymentIntentId}`,
      stripePaymentIntentId,
      amountTotal: 1000,
      currency: "usd",
    },
    { durationDays: null },
    new Date(),
  );
  return { userId, planId: plan.id };
}

const refunded = { status: "refunded" as const, amountRefunded: 1000 };

describe("syncPurchaseCharge", () => {
  test("writes the live state when it differs, and reports the change", async () => {
    const { userId, planId } = await seedPurchase("pi_1");

    const res = await syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => refunded);

    expect(res).toEqual({
      found: true,
      updated: true,
      from: { status: "paid", amountRefunded: 0 },
      to: refunded,
      purchase: { id: (await getAllPurchases({ userId }))[0]!.id, userId, planId, currency: "usd" },
    });
    expect((await getAllPurchases({ userId }))[0]).toMatchObject(refunded);
  });

  test("no purchase for the intent: found false, and Stripe is never asked", async () => {
    let resolved = false;
    const res = await syncPurchaseCharge({ stripePaymentIntentId: "pi_none" }, async () => {
      resolved = true;
      return refunded;
    });

    expect(res).toEqual({ found: false });
    expect(resolved).toBe(false);
  });

  test("unchanged, or no charge yet: nothing written", async () => {
    await seedPurchase("pi_1");

    const same = await syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => ({
      status: "paid",
      amountRefunded: 0,
    }));
    const noCharge = await syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => null);

    expect(same).toMatchObject({ found: true, updated: false });
    expect(noCharge).toMatchObject({ found: true, updated: false, to: null });
  });

  test("write: false reports the change without making it", async () => {
    const { userId } = await seedPurchase("pi_1");

    const res = await syncPurchaseCharge(
      { stripePaymentIntentId: "pi_1" },
      async () => refunded,
      { write: false },
    );

    expect(res).toMatchObject({ found: true, updated: true });
    expect((await getAllPurchases({ userId }))[0]?.status).toBe("paid");
  });

  test("a slow Stripe call doesn't hold a database connection - the app keeps answering", async () => {
    // more concurrent syncs than the pool has connections (10), each waiting on Stripe
    for (let i = 0; i < 12; i++) await seedPurchase(`pi_${i}`);
    const syncs = Array.from({ length: 12 }, (_, i) =>
      syncPurchaseCharge({ stripePaymentIntentId: `pi_${i}` }, async () => {
        await Bun.sleep(1500);
        return null;
      }),
    );
    await Bun.sleep(100);

    const started = performance.now();
    await db.execute(sql`select 1`); // a login, a GET /todo, ...
    expect(performance.now() - started).toBeLessThan(500);
    await Promise.all(syncs);
  });

  test("a fetch that finishes after a newer write can't overwrite it", async () => {
    const { userId } = await seedPurchase("pi_1");
    let resolveSlow!: () => void;
    const slowFetchCanFinish = new Promise<void>((r) => (resolveSlow = r));
    let fetches = 0;

    // reads `paid`, then fetches - slowly, and what it gets back (an open dispute) is already
    // out of date by the time it tries to write
    const slow = syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => {
      if (fetches++ === 0) {
        await slowFetchCanFinish;
        return { status: "disputed", amountRefunded: 0 };
      }
      return refunded; // a re-fetch sees the truth
    });
    await Bun.sleep(50);
    // meanwhile a newer sync writes the refund
    await syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => refunded);
    resolveSlow();

    expect(await slow).toMatchObject({ found: true, updated: false });
    expect((await getAllPurchases({ userId }))[0]).toMatchObject(refunded);
  });

  test("gives up with an error if the row keeps changing under it", async () => {
    const { userId } = await seedPurchase("pi_1");
    let n = 0;
    // every fetch races a write that changes the row first
    const res = syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => {
      n++;
      await db
        .update(purchaseTable)
        .set({ amountRefunded: n })
        .where(eq(purchaseTable.stripePaymentIntentId, "pi_1"));
      return refunded;
    });

    await expect(res).rejects.toThrow();
    expect((await getAllPurchases({ userId }))[0]?.status).toBe("paid");
  });
});
