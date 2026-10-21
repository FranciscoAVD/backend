import { describe, expect, test } from "bun:test";
import { refundConfirmationEmail } from "@backend/f/email/templates/refund-confirmation";

describe("refundConfirmationEmail", () => {
  test("includes the given name, plan name, and formatted amount", async () => {
    const { subject, html, text } = await refundConfirmationEmail({
      name: "Ada",
      planName: "Pro",
      amountRefunded: 1999,
      currency: "usd",
    });

    expect(subject).toBe("Your refund has been processed");
    expect(html).toContain("Hi Ada,");
    expect(html).toContain("Pro");
    expect(html).toContain("$19.99");
    expect(text).toContain("$19.99");
  });

  test("formats the amount per the given currency, case-insensitively", async () => {
    const { html } = await refundConfirmationEmail({
      name: "Ada",
      planName: "Pro",
      amountRefunded: 500,
      currency: "EUR",
    });

    expect(html).toContain("€5.00");
  });

  test("escapes a plan name containing HTML, same as any other React-rendered text", async () => {
    const { html } = await refundConfirmationEmail({
      name: "Ada",
      planName: "<img src=x onerror=alert(1)>",
      amountRefunded: 1000,
      currency: "usd",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renders no image when logoUrl is omitted", async () => {
    const { html } = await refundConfirmationEmail({
      name: "Ada",
      planName: "Pro",
      amountRefunded: 1000,
      currency: "usd",
    });

    expect(html).not.toContain("<img");
  });

  test("renders the logo when logoUrl is given", async () => {
    const { html } = await refundConfirmationEmail({
      name: "Ada",
      planName: "Pro",
      amountRefunded: 1000,
      currency: "usd",
      logoUrl: "https://example.test/logo.png",
    });

    expect(html).toContain('src="https://example.test/logo.png"');
  });
});
