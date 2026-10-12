/**
 * @description CLI wrapper for `lib/reconcile.ts`'s `run`. See that file for the actual logic.
 *
 * Usage: bun run payments:reconcile [--days 14] [--dry-run]
 */
import { parseArgs } from "node:util";
import { run } from "@f/payments/lib/reconcile";
import { PROCESSING_TTL_SEC } from "@f/payments/lib/pending-checkout";
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

// setup or listing failures (bad key, Stripe down) end the run; per-session ones don't
const [summary, runError] = await tryCatch(run(days, dryRun));
const result = summary ?? { scanned: 0, inserted: 0, updated: 0, failed: 0 };
if (runError) {
  result.failed++;
  logger.error({ err: runError }, "payments.reconcile.run");
}

logger.info({ ...result, days, dryRun }, "payments.reconcile.summary");
process.exit(result.failed ? 1 : 0);
