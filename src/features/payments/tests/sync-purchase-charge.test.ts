import { describe, expect, test, beforeEach } from "bun:test";
import { resetDb, seedUser, seedPlan } from "@/test-helpers/db";
import { syncPurchaseCharge } from "@f/payments/use-cases/sync-purchase-charge";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";

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
  return userId;
}

const refunded = { status: "refunded" as const, amountRefunded: 1000 };

describe("syncPurchaseCharge", () => {
  test("writes the live state when it differs, and reports the change", async () => {
    const userId = await seedPurchase("pi_1");

    const res = await syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => refunded);

    expect(res).toEqual({
      found: true,
      updated: true,
      from: { status: "paid", amountRefunded: 0 },
      to: refunded,
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
    const userId = await seedPurchase("pi_1");

    const res = await syncPurchaseCharge(
      { stripePaymentIntentId: "pi_1" },
      async () => refunded,
      { write: false },
    );

    expect(res).toMatchObject({ found: true, updated: true });
    expect((await getAllPurchases({ userId }))[0]?.status).toBe("paid");
  });

  test("a second sync waits for the first to commit before fetching", async () => {
    await seedPurchase("pi_1");
    const order: string[] = [];

    await Promise.all([
      syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => {
        order.push("first fetch starts");
        await Bun.sleep(100);
        order.push("first fetch ends");
        return { status: "paid", amountRefunded: 0 };
      }),
      (async () => {
        await Bun.sleep(20);
        return syncPurchaseCharge({ stripePaymentIntentId: "pi_1" }, async () => {
          order.push("second fetch starts");
          return refunded;
        });
      })(),
    ]);

    expect(order).toEqual(["first fetch starts", "first fetch ends", "second fetch starts"]);
  });
});
