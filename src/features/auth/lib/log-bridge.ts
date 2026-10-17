import type { Logger } from "pino";
import { logger } from "@/lib/logger";

/**
 * Bridges every better-auth-internal log (plugins included) into this app's pino logger, instead
 * of better-auth's own console output. The stripe plugin's checkout.session.completed handler
 * always looks up a subscription, even for a one-time payment-mode checkout where there isn't one
 * (checkoutSession.subscription is null) - that 404s every time and isn't a real failure, so
 * demote it instead of letting it page whatever alerts on error-level logs.
 *
 * Factored out as a function of the target logger (rather than closing over `logger` directly) so
 * a test can point it at a throwaway pino instance and inspect the real serialized output -
 * pino reserves the `msg` key for its own second-argument message, so a merging object that also
 * sets `msg` produces two `"msg"` keys in the written JSON line, and most consumers (including
 * plain `JSON.parse`) keep only the last one. Confirmed empirically against the real `pino`
 * package: the previous `logger[level]({ msg: message, args }, "auth.internal")` shape here lost
 * every real better-auth message behind the literal string "auth.internal", and stuffed any
 * attached `Error` (e.g. better-auth's own `logger.error("...", e)`) into a plain `args` field
 * instead of the `err` key pino's default serializer expands `.message`/`.stack` from.
 */
export function createAuthLoggerBridge(target: Pick<Logger, "debug" | "info" | "warn" | "error">) {
  return {
    log: (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) => {
      if (level === "error" && /subscription.*'null'/i.test(message)) {
        target.warn(
          { betterAuthMessage: message },
          "payments.webhook.one_time_checkout_has_no_subscription",
        );
        return;
      }
      const err = args[0];
      target[level](err !== undefined ? { err } : {}, message);
    },
  };
}

export const authLoggerBridge = createAuthLoggerBridge(logger);
