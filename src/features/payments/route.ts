import { Hono } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";
import { validator } from "hono/validator";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@f/auth/middleware";

import {
  checkoutSchema,
  insertPlanSchema,
  updatePlanSchema,
} from "@f/payments/lib/schemas";
import { isCheckoutSessionId } from "@f/payments/lib/utils";

import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { idParamValidator, jsonValidator } from "@/lib/validators";

import { rateLimiter } from "@/lib/rate-limit";

import { paymentsRepo } from "@f/payments/repo";

const writeRateLimit = rateLimiter<RequireSessionEnv>({
  keyPrefix: "payments-write",
  windowSec: 60,
  max: 20,
  by: (c) => c.get("session").user.id,
});

const sessionIdParamValidator = validator("param", (value, c) => {
  const sessionId = value["sessionId"];
  if (!isCheckoutSessionId(sessionId))
    return c.json(
      {
        error: {
          sessionId: { errors: ["Expected a Stripe checkout session ID."] },
        },
        message: "Invalid param",
      },
      HTTP.BadRequest,
    );
  return { sessionId };
});

// chained in one expression, all the way to the export: RPC's inferred
// AppType only picks up routes/validators registered on the exact value
// assigned to `app`, not ones added via a later, separate statement
const app = new Hono<PinoLoggerEnv>()
  .use(sessionMiddleware)
  .use(requireSessionMiddleware)
  .get("/plans", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(paymentsRepo.plan.getAll());
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "payments.plan.getAll");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }
    return c.json({ data: res, message: "Plans found" }, HTTP.OK);
  })
  .get("/plans/:id", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [res, error] = await tryCatch(paymentsRepo.plan.get({ id }));
    if (error) {
      c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.get");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }

    return !res
      ? c.json({ message: "Plan not found" }, HTTP.NotFound)
      : c.json({ data: res, message: "Plan found" }, HTTP.OK);
  })
  .get("/plans/:id/access", idParamValidator, async (c) => {
    const { user } = c.get("session");
    const { id } = c.req.valid("param");

    const [plan, planError] = await tryCatch(paymentsRepo.plan.get({ id }));
    if (planError) {
      c.var.logger.error({ err: planError, user: user.id, plan: id }, "payments.plan.access");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }

    if (!plan) return c.json({ message: "Plan not found" }, HTTP.NotFound);

    // subscriptions' access is governed by their Stripe subscription period, not a
    // `purchase` row - hasActivePurchase would silently always answer false for one
    if (plan.type !== "one_time")
      return c.json(
        { message: "Plan is not a one-time plan" },
        HTTP.UnprocessableEntity,
      );

    const [active, activeError] = await tryCatch(
      paymentsRepo.purchase.hasActive(
        { userId: user.id, planId: plan.id },
        { overlapping: plan.overlapping },
      ),
    );
    if (activeError) {
      c.var.logger.error(
        { err: activeError, user: user.id, plan: plan.id },
        "payments.plan.access",
      );
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }

    return c.json({ data: { active }, message: "Access checked" }, HTTP.OK);
  })
  .get(
    "/audit-log",
    requirePermissionMiddleware({ auditLog: ["list"] }),
    async (c) => {
      const { user } = c.get("session");
      const targetUserId = c.req.query("userId");

      const [res, error] = await tryCatch(
        targetUserId
          ? paymentsRepo.auditLog.getByUser({ userId: targetUserId })
          : paymentsRepo.auditLog.getAll(),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.auditLog.get");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return c.json({ data: res, message: "Audit log found" }, HTTP.OK);
    },
  )
  .get("/purchases", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(paymentsRepo.purchase.getAll({ userId: user.id }));
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "payments.purchase.getAll");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }
    return c.json(
      { data: res, message: "Purchases found" },
      HTTP.OK,
    );
  })
  .get("/checkout/:sessionId", sessionIdParamValidator, async (c) => {
    const { user } = c.get("session");
    const { sessionId } = c.req.valid("param");

    const [res, error] = await tryCatch(
      paymentsRepo.checkout.getStatus({
        userId: user.id,
        stripeCheckoutSessionId: sessionId,
      }),
    );

    if (error) {
      c.var.logger.error(
        { err: error, user: user.id, session: sessionId },
        "payments.checkout.status",
      );
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }

    return !res
      ? c.json({ message: "Checkout not found" }, HTTP.NotFound)
      : c.json(
          { data: { status: res }, message: "Checkout found" },
          HTTP.OK,
        );
  })
  .use(writeRateLimit)
  .post(
    "/plans",
    requirePermissionMiddleware({ plan: ["create"] }),
    jsonValidator(insertPlanSchema),
    async (c) => {
      const { user } = c.get("session");
      const body = c.req.valid("json");

      // checked before touching Stripe so a duplicate doesn't create an orphan product
      const [existing, existingError] = await tryCatch(
        paymentsRepo.plan.getByName({ name: body.data.name }),
      );

      if (existingError) {
        c.var.logger.error(
          { err: existingError, user: user.id },
          "payments.plan.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (existing)
        return c.json(
          { message: "A plan with that name already exists" },
          HTTP.Conflict,
        );

      const [res, error] = await tryCatch(paymentsRepo.plan.add(body.data));

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.plan.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) {
        c.var.logger.error(
          { err: new Error("Could not create plan"), user: user.id },
          "payments.plan.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return c.json(
        { data: res, message: "Plan created" },
        HTTP.Created,
      );
    },
  )
  .patch(
    "/plans/:id",
    idParamValidator,
    requirePermissionMiddleware({ plan: ["update"] }),
    jsonValidator(updatePlanSchema),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");
      const { data } = c.req.valid("json");

      const [res, error] = await tryCatch(paymentsRepo.plan.update({ id }, data));

      if (error) {
        c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return !res
        ? c.json({ message: "Plan not found" }, HTTP.NotFound)
        : c.body(null, HTTP.NoContent);
    },
  )
  .post(
    "/checkout",
    jsonValidator(checkoutSchema),
    async (c) => {
      const { user } = c.get("session");
      const { data } = c.req.valid("json");

      const [plan, planError] = await tryCatch(paymentsRepo.plan.get({ id: data.planId }));

      if (planError) {
        c.var.logger.error(
          { err: planError, user: user.id, plan: data.planId },
          "payments.checkout.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!plan || !plan.active)
        return c.json({ message: "Plan not found" }, HTTP.NotFound);

      // subscriptions go through better-auth's /api/auth/subscription/upgrade
      if (plan.type !== "one_time")
        return c.json(
          { message: "Plan is not a one-time plan" },
          HTTP.UnprocessableEntity,
        );

      if (!plan.repeatable) {
        const [existing, existingError] = await tryCatch(
          paymentsRepo.purchase.getBlockingByPlan({
            userId: user.id,
            planId: plan.id,
          }),
        );

        if (existingError) {
          c.var.logger.error(
            { err: existingError, user: user.id, plan: plan.id },
            "payments.checkout.create",
          );
          return c.json(
            { message: "Something went wrong. Try again later." },
            HTTP.InternalServerError,
          );
        }

        if (existing) {
          const [, auditError] = await tryCatch(
            paymentsRepo.auditLog.add({
              type: "checkout_blocked_existing_purchase",
              userId: user.id,
              planId: plan.id,
              existingPurchaseId: existing.id,
            }),
          );
          if (auditError)
            c.var.logger.warn(
              { err: auditError, user: user.id, plan: plan.id },
              "payments.audit.write_failed",
            );
          return c.json(
            { message: "You've already purchased this plan" },
            HTTP.Conflict,
          );
        }

        const [hasPending, pendingError] = await tryCatch(
          paymentsRepo.checkout.hasPending(user.id, plan.id),
        );

        if (pendingError) {
          c.var.logger.error(
            { err: pendingError, user: user.id, plan: plan.id },
            "payments.checkout.create",
          );
          return c.json(
            { message: "Something went wrong. Try again later." },
            HTTP.InternalServerError,
          );
        }

        if (hasPending) {
          const [, auditError] = await tryCatch(
            paymentsRepo.auditLog.add({
              type: "checkout_blocked_pending_checkout",
              userId: user.id,
              planId: plan.id,
            }),
          );
          if (auditError)
            c.var.logger.warn(
              { err: auditError, user: user.id, plan: plan.id },
              "payments.audit.write_failed",
            );
          return c.json(
            { message: "You already have a checkout in progress for this plan" },
            HTTP.Conflict,
          );
        }
      }

      const [stripeCustomerId, customerError] = await tryCatch(
        paymentsRepo.customer.ensure({
          id: user.id,
          name: user.name,
          email: user.email,
        }),
      );

      if (customerError) {
        c.var.logger.error(
          { err: customerError, user: user.id },
          "payments.customer.ensure",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      const [res, error] = await tryCatch(
        paymentsRepo.checkout.create({ userId: user.id, stripeCustomerId }, plan),
      );

      if (error) {
        c.var.logger.error(
          { err: error, user: user.id, plan: plan.id },
          "payments.checkout.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      return c.json(
        { data: res, message: "Checkout created" },
        HTTP.OK,
      );
    },
  );

export default app;
