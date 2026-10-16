import { logger } from "@/lib/logger";

/**
 * Bridges every better-auth-internal log (plugins included) into this app's pino logger, instead
 * of better-auth's own console output. The stripe plugin's checkout.session.completed handler
 * always looks up a subscription, even for a one-time payment-mode checkout where there isn't one
 * (checkoutSession.subscription is null) - that 404s every time and isn't a real failure, so
 * demote it instead of letting it page whatever alerts on error-level logs.
 */
export const authLoggerBridge = {
  log: (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) => {
    if (level === "error" && /subscription.*'null'/i.test(message)) {
      logger.warn({ msg: message }, "payments.webhook.one_time_checkout_has_no_subscription");
      return;
    }
    logger[level]({ msg: message, args }, "auth.internal");
  },
};
