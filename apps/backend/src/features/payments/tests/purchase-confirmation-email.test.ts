import { describe, expect, test, beforeEach, mock } from "bun:test";
import { resetDb, seedUser } from "@backend/test-helpers/db";

let sendCalls: Record<string, unknown>[] = [];

// mocks @backend/f/email/lib/client, not @backend/f/email/send - see CLAUDE.md's testing section for why.
mock.module("@backend/f/email/lib/client", () => ({
  getEmailClient: () => ({
    emails: {
      send: async (payload: Record<string, unknown>) => {
        sendCalls.push(payload);
        return { data: { id: "email_1" }, error: null };
      },
    },
  }),
}));

import { sendPurchaseConfirmationEmail } from "@backend/f/payments/lib/purchase-confirmation-email";

beforeEach(async () => {
  await resetDb();
  sendCalls = [];
});

describe("sendPurchaseConfirmationEmail", () => {
  test("sends to the user's own email, looked up from the DB, with the plan name and amount", async () => {
    const userId = await seedUser({ email: "buyer@example.test", name: "Ada" });

    await sendPurchaseConfirmationEmail({
      userId,
      planName: "Pro",
      amountTotal: 1999,
      currency: "usd",
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toBe("buyer@example.test");
    expect(sendCalls[0]?.subject).toBe("Thanks for your purchase");
    expect(sendCalls[0]?.html).toContain("Hi Ada,");
    expect(sendCalls[0]?.html).toContain("$19.99");
  });

  test("logs and resolves, without sending, when the user no longer exists", async () => {
    await expect(
      sendPurchaseConfirmationEmail({
        userId: crypto.randomUUID(),
        planName: "Pro",
        amountTotal: 1999,
        currency: "usd",
      }),
    ).resolves.toBeUndefined();

    expect(sendCalls).toHaveLength(0);
  });
});
