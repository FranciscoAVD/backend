/**
 * @description CLI wrapper for `services/reconcile.ts`'s `purchases`. See that file for the
 * actual logic.
 *
 * Usage: bun run payments:reconcile [--days 14] [--dry-run]
 */
import { parseArgs } from "node:util";
import { paymentsServices } from "@f/payments/services";
import { PROCESSING_TTL_SEC } from "@f/payments/lib/constants";
import { logger } from "@/lib/logger";
import tryCatch from "@vicstack/try-catch";

// delayed payment methods (e.g. bank debits) can take up to PROCESSING_TTL_SEC to settle -
// scanning any less than that risks missing a late settlement whose webhook was lost
const DEFAULT_DAYS = Math.ceil(PROCESSING_TTL_SEC / (24 * 60 * 60));

const { values } = parseArgs({
  options: {
    days: { type: "string", default: String(DEFAULT_DAYS) },
    "dry-run": { type: "boolean", default: false },
  },
});
const days = Number(values.days);
const dryRun = values["dry-run"];
if (!Number.isInteger(days) || days <= 0) {
  logger.error({ days: values.days }, "payments.reconcile.args");
  process.exit(1);
}

// setup or listing failures (bad key, Stripe down) end the run; per-session/per-subscription
// ones don't - each pass counts its own failures instead
const [summary, runError] = await tryCatch(paymentsServices.reconcile.purchases(days, dryRun));
const result = summary ?? { scanned: 0, inserted: 0, updated: 0, failed: 0 };
if (runError) {
  result.failed++;
  logger.error({ err: runError }, "payments.reconcile.run");
}
logger.info({ ...result, days, dryRun }, "payments.reconcile.summary");

// a second, independent pass - catches subscription rows a webhook left stale (see
// services/reconcile.ts's `subscriptions`), not one-time purchases
const [subscriptionSummary, subscriptionRunError] = await tryCatch(
  paymentsServices.reconcile.subscriptions(dryRun),
);
const subscriptionResult = subscriptionSummary ?? { checked: 0, updated: 0, failed: 0 };
if (subscriptionRunError) {
  subscriptionResult.failed++;
  logger.error({ err: subscriptionRunError }, "payments.reconcile.subscriptions_run");
}
logger.info(
  { ...subscriptionResult, dryRun },
  "payments.reconcile.subscriptions_summary",
);

process.exit(result.failed || subscriptionResult.failed ? 1 : 0);
