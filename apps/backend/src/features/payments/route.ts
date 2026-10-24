import { Hono } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";
import { validator } from "hono/validator";
import { z } from "zod";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@backend/f/auth/middleware";

import {
  auditLogQuerySchema,
  purchasesQuerySchema,
  checkoutSchema,
  insertPlanSchema,
  updatePlanSchema,
  refundPurchaseSchema,
} from "@backend/f/payments/lib/schemas";
import { isCheckoutSessionId } from "@backend/f/payments/lib/utils";

import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { idParamValidator, jsonValidator } from "@backend/lib/validators";

import { rateLimiter } from "@backend/lib/rate-limit";

import { paymentsRepo } from "@backend/f/payments/repo";
import { paymentsServices } from "@backend/f/payments/services";

// every route, reads included: better-auth's own limiter only covers /api/auth, so without this
// the GETs below (a DB and Redis round trip each, and GET /purchases unpaginated) had no limit at
// all. Generous enough for a client polling GET /checkout/:sessionId every second
const readRateLimit = rateLimiter<RequireSessionEnv>({
  keyPrefix: "payments-read",
  windowSec: 60,
  max: 120,
  by: (c) => c.get("session").user.id,
});

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

const auditLogQueryValidator = validator("query", (value, c) => {
  const { success, data, error } = auditLogQuerySchema.safeParse(value);
  if (!success)
    return c.json(
      { error: z.treeifyError(error).properties, message: "Invalid query" },
      HTTP.BadRequest,
    );
  return data;
});

const purchasesQueryValidator = validator("query", (value, c) => {
  const { success, data, error } = purchasesQuerySchema.safeParse(value);
  if (!success)
    return c.json(
      { error: z.treeifyError(error).properties, message: "Invalid query" },
      HTTP.BadRequest,
    );
  return data;
});

// chained in one expression, all the way to the export: RPC's inferred
// AppType only picks up routes/validators registered on the exact value
// assigned to `app`, not ones added via a later, separate statement
const app = new Hono<PinoLoggerEnv>()
  .use(sessionMiddleware)
  .use(requireSessionMiddleware)
  .use(readRateLimit)
  .get(
    "/plans",
    requirePermissionMiddleware({ plan: ["read:active"] }),
    async (c) => {
      const { user } = c.get("session");

      // read:all additionally includes inactive plans - same inline check as GET /plans/:id,
      // since it's a second, optional permission layered on top of read:active, not a reason to
      // gate the whole route (that would also block active-plan listing for non-admins)
      let includeInactive = false;
      await requirePermissionMiddleware({ plan: ["read:all"] })(
        c as unknown as Parameters<ReturnType<typeof requirePermissionMiddleware>>[0],
        async () => {
          includeInactive = true;
        },
      );

      const [res, error] = await tryCatch(
        includeInactive ? paymentsRepo.plan.get.all() : paymentsRepo.plan.get.active(),
      );
      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.plan.get_all");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }
      return c.json({ data: res, message: "Plans found" }, HTTP.OK);
    },
  )
  .get(
    "/plans/:id",
    idParamValidator,
    requirePermissionMiddleware({ plan: ["read:active"] }),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");

      const [res, error] = await tryCatch(paymentsRepo.plan.get.one({ id }));
      if (error) {
        c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.get");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) return c.json({ message: "Plan not found" }, HTTP.NotFound);

      // inactive plans are admin-only (read:all) - checked here, not as route middleware,
      // since active plans stay visible to anyone with just read:active; 404 rather than 403
      // so a non-admin can't tell an inactive plan with this id exists at all
      if (!res.active) {
        let authorized = false;
        await requirePermissionMiddleware({ plan: ["read:all"] })(
          c as unknown as Parameters<ReturnType<typeof requirePermissionMiddleware>>[0],
          async () => {
            authorized = true;
          },
        );
        if (!authorized) return c.json({ message: "Plan not found" }, HTTP.NotFound);
      }

      return c.json({ data: res, message: "Plan found" }, HTTP.OK);
    },
  )
  .get(
    "/plans/:id/access",
    idParamValidator,
    // the same gate as GET /plans/:id: without it, anyone signed in could probe which plan ids
    // exist (404 vs 200) even with no permission to read plans at all
    requirePermissionMiddleware({ plan: ["read:active"] }),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");

      const [res, error] = await tryCatch(paymentsServices.plan.access({ userId: user.id, planId: id }));
      if (error) {
        c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.access");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) return c.json({ message: "Plan not found" }, HTTP.NotFound);

      // a retired plan is only revealed to someone who still holds it, or to an admin (read:all) -
      // anyone else gets the same 404 as a plan that never existed, matching GET /plans/:id
      if (!res.planActive && !res.active) {
        let authorized = false;
        await requirePermissionMiddleware({ plan: ["read:all"] })(
          c as unknown as Parameters<ReturnType<typeof requirePermissionMiddleware>>[0],
          async () => {
            authorized = true;
          },
        );
        if (!authorized) return c.json({ message: "Plan not found" }, HTTP.NotFound);
      }

      return c.json({ data: { active: res.active }, message: "Access checked" }, HTTP.OK);
    },
  )
  .get("/access", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(
      paymentsRepo.access.activePlans({ userId: user.id }),
    );
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "payments.access.activePlans");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP.InternalServerError,
      );
    }
    return c.json({ data: res, message: "Active plans found" }, HTTP.OK);
  })
  .get(
    "/audit-log",
    requirePermissionMiddleware({ audit: ["list"] }),
    auditLogQueryValidator,
    async (c) => {
      const { user } = c.get("session");
      const { userId: targetUserId, limit, before } = c.req.valid("query");

      // one row past the page size, to tell whether there's a next page without a count query
      const pageOptions = { limit: limit + 1, before };
      const [rows, error] = await tryCatch(
        targetUserId
          ? paymentsRepo.audit.get.byUser({ userId: targetUserId }, pageOptions)
          : paymentsRepo.audit.get.all(pageOptions),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.audit.get");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      const data = rows.slice(0, limit);
      // pass back as ?before= to get the next (older) page; null on the last page
      const nextCursor = rows.length > limit ? (data.at(-1)?.id ?? null) : null;
      return c.json({ data, nextCursor, message: "Audit log found" }, HTTP.OK);
    },
  )
  .get("/purchases", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(paymentsRepo.purchase.get.mineWithAccess({ userId: user.id }));
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "payments.purchase.get_all");
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
  .get(
    "/purchases/all",
    requirePermissionMiddleware({ purchase: ["read:all"] }),
    purchasesQueryValidator,
    async (c) => {
      const { user } = c.get("session");
      const { userId: targetUserId, limit, before } = c.req.valid("query");

      // one row past the page size, to tell whether there's a next page without a count query
      const pageOptions = { limit: limit + 1, before };
      const [rows, error] = await tryCatch(
        targetUserId
          ? paymentsRepo.purchase.get.byUserAdmin({ userId: targetUserId }, pageOptions)
          : paymentsRepo.purchase.get.allAdmin(pageOptions),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.purchase.get_all_admin");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      const data = rows.slice(0, limit);
      // pass back as ?before= to get the next (older) page; null on the last page
      const nextCursor = rows.length > limit ? (data.at(-1)?.id ?? null) : null;
      return c.json({ data, nextCursor, message: "Purchases found" }, HTTP.OK);
    },
  )
  .get("/checkout/:sessionId", sessionIdParamValidator, async (c) => {
    const { user } = c.get("session");
    const { sessionId } = c.req.valid("param");

    const [res, error] = await tryCatch(
      paymentsServices.checkout.status({
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
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(paymentsServices.plan.create(data));

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.plan.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (res.kind === "duplicate_name")
        return c.json(
          { message: "A plan with that name already exists" },
          HTTP.Conflict,
        );

      return c.json(
        { data: res.plan, message: "Plan created" },
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
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(paymentsServices.plan.update({ id }, data));

      if (error) {
        c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      switch (res.kind) {
        case "not_found":
          return c.json({ message: "Plan not found" }, HTTP.NotFound);
        case "invalid_field":
          return c.json({ message: res.message }, HTTP.UnprocessableEntity);
        case "repeat_blocked":
          return c.json(
            {
              message:
                "Can't make this plan repeatable - it already has a purchase that would be reopened to repeat buys",
            },
            HTTP.Conflict,
          );
        case "updated_sync_failed":
        case "updated_expire_failed":
          return c.json({ message: res.message }, HTTP.InternalServerError);
        case "updated":
          return c.body(null, HTTP.NoContent);
      }
    },
  )
  .post(
    "/checkout",
    jsonValidator(checkoutSchema),
    async (c) => {
      const { user } = c.get("session");
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(
        paymentsServices.checkout.start(
          { userId: user.id, name: user.name, email: user.email },
          { planId: data.planId },
        ),
      );

      if (error) {
        c.var.logger.error(
          { err: error, user: user.id, plan: data.planId },
          "payments.checkout.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      switch (res.kind) {
        case "not_found":
          return c.json({ message: "Plan not found" }, HTTP.NotFound);
        case "wrong_type":
          return c.json({ message: "Plan is not a one-time plan" }, HTTP.UnprocessableEntity);
        case "deleting":
          return c.json({ message: "This account is being deleted" }, HTTP.Conflict);
        case "slot_taken":
          return c.json(
            { message: "You already have a checkout in progress for this plan" },
            HTTP.Conflict,
          );
        case "owned":
          return c.json({ message: "You've already purchased this plan" }, HTTP.Conflict);
        case "resumed":
          return c.json(
            { data: { sessionId: res.sessionId, url: res.url }, message: "Checkout resumed" },
            HTTP.OK,
          );
        case "created":
          return c.json(
            { data: { sessionId: res.sessionId, url: res.url }, message: "Checkout created" },
            HTTP.OK,
          );
      }
    },
  )
  .post(
    "/purchases/:id/refund",
    idParamValidator,
    requirePermissionMiddleware({ purchase: ["refund"] }),
    jsonValidator(refundPurchaseSchema),
    async (c) => {
      const { user } = c.get("session");
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");

      const [res, error] = await tryCatch(
        paymentsServices.fulfillment.refund({ id }, { id: user.id }, data),
      );
      if (error) {
        c.var.logger.error({ err: error, user: user.id, purchase: id }, "payments.purchase.refund");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      switch (res.kind) {
        case "not_found":
          return c.json({ message: "Purchase not found" }, HTTP.NotFound);
        case "no_payment_intent":
          return c.json(
            { message: "This purchase has no payment to refund" },
            HTTP.UnprocessableEntity,
          );
        case "already_refunded":
          return c.json(
            { message: "This purchase has already been refunded" },
            HTTP.Conflict,
          );
        case "charge_disputed":
          return c.json(
            {
              message:
                "This charge is currently disputed and can't be refunded until the dispute is resolved",
            },
            HTTP.Conflict,
          );
        case "amount_exceeds_refundable":
          return c.json(
            { message: "The refund amount exceeds what's left to refund on this charge" },
            HTTP.UnprocessableEntity,
          );
        case "idempotency_conflict":
          return c.json(
            {
              message:
                "This idempotency key was already used for a different refund. Use a new key for a new refund.",
            },
            HTTP.Conflict,
          );
        case "refund_failed":
          return c.json(
            {
              data: { refundId: res.refundId, failureReason: res.failureReason },
              message:
                "Stripe couldn't complete this refund, so no money was returned. Use a new idempotency key to try again.",
            },
            HTTP.UnprocessableEntity,
          );
        case "refunded":
          return c.json(
            {
              data: res.purchase,
              refundId: res.refundId,
              replayed: res.replayed,
              message: res.replayed ? "Refund already issued" : "Purchase refunded",
            },
            HTTP.OK,
          );
      }
    },
  );

export default app;
