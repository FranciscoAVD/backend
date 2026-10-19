import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env as PinoLoggerEnv } from "hono-pino";
import HTTP from "@vicstack/http";
import tryCatch from "@vicstack/try-catch";
import type { RequireSessionEnv } from "@f/auth/middleware";
import type { Payment } from "@f/payments/lib/types";
import { paymentsRepo } from "@f/payments/repo";

export type ActivePlansEnv = PinoLoggerEnv &
  RequireSessionEnv & {
    Variables: {
      // every plan the user has access to right now (`paymentsRepo.access.activePlans`), so a
      // handler behind the guard can read the plans' limits without a second query
      activePlans: Payment.Plan[];
    };
  };

/**
 * Decides whether the user's active plans let the request through. Gets every plan the user has
 * access to right now, each with its `limits`. Combining several plans' limits (highest wins, add
 * up, any-true) is the check's job, since only the app knows what each limit means.
 */
export type PlanCheck = (
  plans: Payment.Plan[],
  c: Context<ActivePlansEnv>,
) => boolean | Promise<boolean>;

/** The 403 body, with a `code` so a client can tell "upgrade" apart from "not allowed". */
const planRequired = { message: "An active plan is required.", code: "PLAN_REQUIRED" } as const;

/**
 * @description Lets a request through only if `check` passes for the user's active plans - both
 * one-time purchases and subscriptions, retired plans counted per `RETIRED_PLANS_KEEP_ACCESS`.
 * Must run after `requireSessionMiddleware`. Fails closed: 403 if the check returns anything but
 * `true`, 500 if loading the plans or the check itself throws. Sets `activePlans` on the context.
 * @example
 * // with planLimitsSchema set to z.object({ exports: z.number() }).partial()
 * .get("/exports", requireActivePlansMiddleware((plans) => plans.some((p) => (p.limits?.exports ?? 0) > 0)), handler)
 */
export const requireActivePlansMiddleware = (check: PlanCheck) =>
  createMiddleware<ActivePlansEnv>(async (c, next) => {
    // the type says a session is here, but only if requireSessionMiddleware actually ran first
    const session = c.get("session");
    if (!session) return c.json({ message: "Unauthenticated" }, HTTP.Unauthorized);
    const userId = session.user.id;

    const [granted, error] = await tryCatch(
      (async () => {
        const plans = await paymentsRepo.access.activePlans({ userId });
        c.set("activePlans", plans);
        return check(plans, c);
      })(),
    );
    if (error) {
      c.var.logger.error({ err: error, user: userId }, "payments.require_plan");
      return c.json({ message: "Something went wrong. Try again later." }, HTTP.InternalServerError);
    }
    if (granted !== true) return c.json(planRequired, HTTP.Forbidden);

    await next();
  });

/**
 * @description Lets a request through only if the user has access to at least one of the named
 * plans right now. Names match case-insensitively, the same way the stripe plugin matches them.
 * Plans are looked up by name, not id, because ids differ between environments.
 *
 * A name that matches no plan at all (a typo, or a plan not created yet in this environment)
 * can't be told apart from "not subscribed" by the check alone - every request would just 403. So
 * a denied request checks the names exist, and logs an error for any that don't.
 * @example
 * .get("/reports", requirePlanMiddleware("pro", "enterprise"), handler)
 */
export const requirePlanMiddleware = (...names: [string, ...string[]]) => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return requireActivePlansMiddleware(async (plans, c) => {
    if (plans.some((plan) => wanted.has(plan.name.toLowerCase()))) return true;

    const [found, lookupError] = await tryCatch(
      Promise.all(names.map((name) => paymentsRepo.plan.get.byName({ name }))),
    );
    // only a diagnostic: the request is denied either way, so a failed lookup isn't a 500
    if (lookupError)
      c.var.logger.warn({ err: lookupError, plans: names }, "payments.require_plan.lookup");
    const unknown = found ? names.filter((_, i) => !found[i]) : [];
    if (unknown.length)
      c.var.logger.error({ plans: unknown }, "payments.require_plan.unknown_plan");
    return false;
  });
};
