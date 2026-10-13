import { describe, expect, test, beforeEach } from "bun:test";
import { hasActiveSubscription } from "@f/payments/use-cases/get-subscription";
import { resetDb, seedUser, seedSubscription } from "@/test-helpers/db";

describe("hasActiveSubscription", () => {
  beforeEach(resetDb);

  test("true when the user has an active subscription to the plan", async () => {
    const userId = await seedUser();
    await seedSubscription({ referenceId: userId, plan: "Pro", status: "active" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(true);
  });

  test("true when the user is trialing the plan", async () => {
    const userId = await seedUser();
    await seedSubscription({ referenceId: userId, plan: "Pro", status: "trialing" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(true);
  });

  test("matches the plan name case-insensitively, same as the plugin's own lookup", async () => {
    const userId = await seedUser();
    await seedSubscription({ referenceId: userId, plan: "pro", status: "active" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(true);
  });

  test("false when the subscription was canceled", async () => {
    const userId = await seedUser();
    await seedSubscription({ referenceId: userId, plan: "Pro", status: "canceled" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(false);
  });

  test("false when the subscription is for a different plan", async () => {
    const userId = await seedUser();
    await seedSubscription({ referenceId: userId, plan: "Basic", status: "active" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(false);
  });

  test("false when the subscription belongs to a different user", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    await seedSubscription({ referenceId: otherUserId, plan: "Pro", status: "active" });

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(false);
  });

  test("false when the user has no subscription at all", async () => {
    const userId = await seedUser();

    expect(await hasActiveSubscription({ userId }, { name: "Pro" })).toBe(false);
  });
});
