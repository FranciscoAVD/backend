import { describe, expect, test, spyOn } from "bun:test";
import { logger } from "@/lib/logger";
import { authLoggerBridge } from "@f/auth/lib/log-bridge";

// Unit-tests the bridge function directly, not through a real betterAuth()/stripe-plugin
// instance: @f/auth/auth is a shared singleton across every test file that imports it, and
// giving it anything less than a fully-featured Stripe fake here would corrupt whichever other
// test file's import of it resolves second in the same `bun test` run (see CLAUDE.md's testing
// section on @f/auth/auth's shared-module-mock hazard) - this avoids that entirely.
describe("authLoggerBridge", () => {
  test("the one-time-checkout subscription-lookup failure is demoted to warn", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = spyOn(logger, "error").mockImplementation(() => logger);

    authLoggerBridge.log("error", "Stripe webhook failed. Error: No such subscription: 'null'");

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      { msg: "Stripe webhook failed. Error: No such subscription: 'null'" },
      "payments.webhook.one_time_checkout_has_no_subscription",
    );

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("a genuine webhook failure still logs at error", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => logger);
    const errorSpy = spyOn(logger, "error").mockImplementation(() => logger);

    authLoggerBridge.log("error", "Stripe webhook failed. Error: Stripe is down");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("non-error levels pass through at the matching pino level", () => {
    const infoSpy = spyOn(logger, "info").mockImplementation(() => logger);

    authLoggerBridge.log("info", "some better-auth info line");

    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});
