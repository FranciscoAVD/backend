import { Hono } from "hono";
import { validator } from "hono/validator";

import { auth } from "@/features/auth/auth";
import { sessionMiddleware } from "@f/auth/middleware/session";
import { requireSessionMiddleware } from "@f/auth/middleware/require";

import { z } from "zod";
import { checkoutSchema, insertPlanSchema } from "@f/payments/lib/schemas";
import { isCheckoutSessionId } from "@f/payments/lib/utils";

import { logger } from "@/lib/logger";
import { tryCatch } from "@/lib/utils";
import { HTTP_STATUS } from "@/lib/http-status";

import { rateLimiter } from "@/lib/rate-limit";

import {
  getPlan,
  getPlanByName,
  getPlans,
} from "@f/payments/use-cases/get-plans";
import { addPlan } from "@f/payments/use-cases/add-plan";
import { getAllPurchases } from "@f/payments/use-cases/get-purchases";
import {
  createCheckout,
  getCheckoutStatus,
} from "@f/payments/use-cases/checkout";

const writeRateLimit = rateLimiter({
  keyPrefix: "payments-write",
  windowSec: 60,
  max: 20,
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
      HTTP_STATUS.BAD_REQUEST,
    );
  return { sessionId };
});

const app = new Hono();

app
  .use(sessionMiddleware)
  .use(requireSessionMiddleware)
  .get("/plans", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(getPlans());
    if (error) {
      logger.error({ err: error, user: user.id }, "payments.plan.getAll");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }
    return c.json({ data: res, message: "Plans found" }, HTTP_STATUS.SUCCESS);
  })
  .get("/purchases", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(getAllPurchases({ userID: user.id }));
    if (error) {
      logger.error({ err: error, user: user.id }, "payments.purchase.getAll");
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }
    return c.json(
      { data: res, message: "Purchases found" },
      HTTP_STATUS.SUCCESS,
    );
  })
  .get("/checkout/:sessionId", sessionIdParamValidator, async (c) => {
    const { user } = c.get("session");
    const { sessionId } = c.req.valid("param");

    const [res, error] = await tryCatch(
      getCheckoutStatus({
        userID: user.id,
        stripeCheckoutSessionId: sessionId,
      }),
    );

    if (error) {
      logger.error(
        { err: error, user: user.id, session: sessionId },
        "payments.checkout.status",
      );
      return c.json(
        { message: "Something went wrong. Try again later." },
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    return !res
      ? c.json({ message: "Checkout not found" }, HTTP_STATUS.NOT_FOUND)
      : c.json(
          { data: { status: res }, message: "Checkout found" },
          HTTP_STATUS.SUCCESS,
        );
  })
  .use(writeRateLimit)
  .post(
    "/plans",
    validator("json", (value, c) => {
      const { success, data, error } = insertPlanSchema.safeParse(value);
      if (!success)
        return c.json(
          {
            error: z.treeifyError(error).properties,
            message: "Failed to parse",
          },
          HTTP_STATUS.UNPROCESSABLE_ENTITY,
        );
      return {
        data,
      };
    }),
    async (c) => {
      const { user } = c.get("session");
      const body = c.req.valid("json");

      const [can, canError] = await tryCatch(
        auth.api.userHasPermission({
          body: {
            userId: user.id,
            permissions: {
              plan: ["create"],
            },
          },
        }),
      );

      if (canError) {
        logger.error(
          { err: canError, user: user.id },
          "auth.permission.plan.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!can.success)
        return c.json({ message: "Unauthorized" }, HTTP_STATUS.FORBIDDEN);

      // checked before touching Stripe so a duplicate doesn't create an orphan product
      const [existing, existingError] = await tryCatch(
        getPlanByName({ name: body.data.name }),
      );

      if (existingError) {
        logger.error(
          { err: existingError, user: user.id },
          "payments.plan.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (existing)
        return c.json(
          { message: "A plan with that name already exists" },
          HTTP_STATUS.CONFLICT,
        );

      const [res, error] = await tryCatch(addPlan(body.data));

      if (error) {
        logger.error({ err: error, user: user.id }, "payments.plan.add");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!res) {
        logger.error(
          { err: new Error("Could not create plan"), user: user.id },
          "payments.plan.add",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      return c.json(
        { data: res, message: "Plan created" },
        HTTP_STATUS.CREATED,
      );
    },
  )
  .post(
    "/checkout",
    validator("json", (value, c) => {
      const { success, data, error } = checkoutSchema.safeParse(value);
      if (!success)
        return c.json(
          {
            error: z.treeifyError(error).properties,
            message: "Failed to parse",
          },
          HTTP_STATUS.UNPROCESSABLE_ENTITY,
        );
      return {
        data,
      };
    }),
    async (c) => {
      const { user } = c.get("session");
      const { data } = c.req.valid("json");

      const [plan, planError] = await tryCatch(getPlan({ id: data.planID }));

      if (planError) {
        logger.error(
          { err: planError, user: user.id, plan: data.planID },
          "payments.checkout.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      if (!plan || !plan.active)
        return c.json({ message: "Plan not found" }, HTTP_STATUS.NOT_FOUND);

      // subscriptions go through better-auth's /api/auth/subscription/upgrade
      if (plan.type !== "one_time")
        return c.json(
          { message: "Plan is not a one-time plan" },
          HTTP_STATUS.UNPROCESSABLE_ENTITY,
        );

      const [res, error] = await tryCatch(
        createCheckout(
          {
            userID: user.id,
            email: user.email,
            stripeCustomerId: user.stripeCustomerId,
          },
          plan,
        ),
      );

      if (error) {
        logger.error(
          { err: error, user: user.id, plan: plan.id },
          "payments.checkout.create",
        );
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
        );
      }

      return c.json(
        { data: res, message: "Checkout created" },
        HTTP_STATUS.SUCCESS,
      );
    },
  );

export default app;
