import { describe, expect, test } from "bun:test";
import { resetPasswordEmail } from "@backend/f/email/templates/reset-password";

describe("resetPasswordEmail", () => {
  test("includes the given name and a link to the given url", async () => {
    const { subject, html, text } = await resetPasswordEmail({
      name: "Ada",
      url: "https://example.test/reset-password?token=abc",
    });

    expect(subject).toBe("Reset your password");
    expect(html).toContain("Hi Ada,");
    expect(html).toContain('href="https://example.test/reset-password?token=abc"');
    expect(text).toContain("https://example.test/reset-password?token=abc");
  });

  test("escapes a name containing HTML, same as any other React-rendered text", async () => {
    const { html } = await resetPasswordEmail({
      name: "<img src=x onerror=alert(1)>",
      url: "https://example.test/reset-password",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renders no image when logoUrl is omitted", async () => {
    const { html } = await resetPasswordEmail({
      name: "Ada",
      url: "https://example.test/reset-password",
    });

    expect(html).not.toContain("<img");
  });

  test("renders the logo when logoUrl is given", async () => {
    const { html } = await resetPasswordEmail({
      name: "Ada",
      url: "https://example.test/reset-password",
      logoUrl: "https://example.test/logo.png",
    });

    expect(html).toContain('src="https://example.test/logo.png"');
  });
});
