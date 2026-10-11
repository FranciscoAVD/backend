import { Hono } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";
import { validator } from "hono/validator";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@f/auth/middleware";

import { checkoutSchema, insertPlanSchema } from "@f/payments/lib/schemas";
import { isCheckoutSessionId } from "@f/payments/lib/utils";

import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { jsonValidator } from "@/lib/validators";

import { rateLimiter } from "@/lib/rate-limit";

import { paymentsRepo } from "@f/payments/payments.repo";

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
  .get("/purchases", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(paymentsRepo.purchase.getAll({ userID: user.id }));
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
        userID: user.id,
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
  .post(
    "/checkout",
    jsonValidator(checkoutSchema),
    async (c) => {
      const { user } = c.get("session");
      const { data } = c.req.valid("json");

      const [plan, planError] = await tryCatch(paymentsRepo.plan.get({ id: data.planID }));

      if (planError) {
        c.var.logger.error(
          { err: planError, user: user.id, plan: data.planID },
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

      const [res, error] = await tryCatch(
        paymentsRepo.checkout.create(
          {
            userID: user.id,
            email: user.email,
            // only present when the stripe plugin is active, which it is whenever this route is reachable
            stripeCustomerId: (user as { stripeCustomerId?: string | null })
              .stripeCustomerId,
          },
          plan,
        ),
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
