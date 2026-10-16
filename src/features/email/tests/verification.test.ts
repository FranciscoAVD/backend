import { describe, expect, test } from "bun:test";
import { verificationEmail } from "@f/email/templates/verification";

describe("verificationEmail", () => {
  test("includes the given name and a link to the given url", async () => {
    const { subject, html, text } = await verificationEmail({
      name: "Ada",
      url: "https://example.test/api/auth/verify-email?token=abc",
    });

    expect(subject).toBe("Verify your email");
    expect(html).toContain("Hi Ada,");
    expect(html).toContain('href="https://example.test/api/auth/verify-email?token=abc"');
    expect(text).toContain("https://example.test/api/auth/verify-email?token=abc");
  });

  test("escapes a name containing HTML, same as any other React-rendered text", async () => {
    const { html } = await verificationEmail({
      name: "<img src=x onerror=alert(1)>",
      url: "https://example.test/verify",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renders no image when logoUrl is omitted", async () => {
    const { html } = await verificationEmail({
      name: "Ada",
      url: "https://example.test/verify",
    });

    expect(html).not.toContain("<img");
  });

  test("renders the logo when logoUrl is given", async () => {
    const { html } = await verificationEmail({
      name: "Ada",
      url: "https://example.test/verify",
      logoUrl: "https://example.test/logo.png",
    });

    expect(html).toContain('src="https://example.test/logo.png"');
  });
});
