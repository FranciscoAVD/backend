import { describe, expect, test } from "bun:test";
import { verificationEmail } from "@f/email/templates/verification";

describe("verificationEmail", () => {
  test("includes the given name and a link to the given url", () => {
    const { subject, html } = verificationEmail({
      name: "Ada",
      url: "https://example.test/api/auth/verify-email?token=abc",
    });

    expect(subject).toBe("Verify your email");
    expect(html).toContain("Hi Ada,");
    expect(html).toContain('href="https://example.test/api/auth/verify-email?token=abc"');
  });

  test("escapes a name containing HTML so it can't break the email's markup", () => {
    const { html } = verificationEmail({
      name: "<img src=x onerror=alert(1)>",
      url: "https://example.test/verify",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
