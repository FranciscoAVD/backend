import { describe, expect, test } from "bun:test";
import { refundReversedAlertEmail } from "@f/email/templates/refund-reversed-alert";

const base = {
  planName: "Lifetime",
  purchaseId: 42,
  buyerEmail: "buyer@example.test",
  stripePaymentIntentId: "pi_reversed",
  refundedBefore: 1000,
  refundedAfter: 400,
  currency: "usd",
};

describe("refundReversedAlertEmail", () => {
  test("names the purchase, buyer and intent, and the amount that never reached the customer", async () => {
    const { subject, html, text } = await refundReversedAlertEmail(base);

    expect(subject).toBe("Action needed: refund on purchase #42 didn't go through");
    for (const part of ["#42", "Lifetime", "buyer@example.test", "pi_reversed", "$10.00", "$4.00"]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
    // the shortfall itself: $10.00 refunded down to $4.00 means $6.00 never arrived
    expect(text).toContain("$6.00 never reached the customer");
  });

  test("says so when the buyer's account no longer exists", async () => {
    const { text } = await refundReversedAlertEmail({ ...base, buyerEmail: null });
    expect(text).toContain("(account deleted)");
  });

  test("escapes a plan name containing HTML", async () => {
    const { html } = await refundReversedAlertEmail({
      ...base,
      planName: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
  });
});
