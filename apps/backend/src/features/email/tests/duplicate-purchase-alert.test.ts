import { describe, expect, test } from "bun:test";
import { duplicatePurchaseAlertEmail } from "@backend/f/email/templates/duplicate-purchase-alert";

const base = {
  planName: "Lifetime",
  buyerEmail: "buyer@example.test",
  buyerUserId: "user_123",
  existingPurchaseId: 41,
  duplicatePurchaseId: 42,
  stripeCheckoutSessionId: "cs_dup",
  amountTotal: 4900,
  currency: "usd",
};

describe("duplicatePurchaseAlertEmail", () => {
  test("names the plan, buyer, both purchases, the session and the amount", async () => {
    const { subject, html, text } = await duplicatePurchaseAlertEmail(base);

    expect(subject).toBe("Action needed: duplicate purchase of Lifetime");
    for (const part of ["buyer@example.test", "user_123", "#41", "#42", "cs_dup", "$49.00"]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
  });

  test("says so when the buyer's account no longer exists", async () => {
    const { text } = await duplicatePurchaseAlertEmail({ ...base, buyerEmail: null });
    expect(text).toContain("(account deleted)");
  });

  test("escapes a plan name containing HTML", async () => {
    const { html } = await duplicatePurchaseAlertEmail({
      ...base,
      planName: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
  });
});
