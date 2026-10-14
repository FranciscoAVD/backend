import { Hono } from "hono";
import type { Env as PinoLoggerEnv } from "hono-pino";
import { validator } from "hono/validator";
import { z } from "zod";

import {
  sessionMiddleware,
  requireSessionMiddleware,
  requirePermissionMiddleware,
  type RequireSessionEnv,
} from "@f/auth/middleware";

import {
  auditLogQuerySchema,
  purchasesQuerySchema,
  checkoutSchema,
  insertPlanSchema,
  updatePlanSchema,
} from "@f/payments/lib/schemas";
import { isCheckoutSessionId } from "@f/payments/lib/utils";
import {
  RETIRED_PLANS_KEEP_ACCESS,
  RETIRING_EXPIRES_OPEN_CHECKOUTS,
} from "@f/payments/lib/access-policy";

import tryCatch from "@vicstack/try-catch";
import HTTP from "@vicstack/http";

import { idParamValidator, jsonValidator } from "@/lib/validators";

import { rateLimiter } from "@/lib/rate-limit";

import { paymentsRepo } from "@f/payments/repo";
import { CheckoutSlotLostError } from "@f/payments/lib/pending-checkout";

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
        includeInactive
          ? paymentsRepo.plan.getAllIncludingInactive()
          : paymentsRepo.plan.getAll(),
      );
      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.plan.getAll");
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

      const [res, error] = await tryCatch(paymentsRepo.plan.get({ id }));
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
        // c is narrower here than requirePermissionMiddleware's own RequireSessionEnv, since
        // it also carries PinoLoggerEnv's `logger` variable via this app's generic - safe at
        // runtime (session is already guaranteed non-null by the chained middleware above),
        // but not something Hono's own invariant Context typing can verify structurally
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

    // one_time access lives in the `purchase` table; recurring access is governed by
    // the subscription's own Stripe period, tracked in better-auth's `subscription` table
    const [active, activeError] = await tryCatch(
      plan.type === "one_time"
        ? paymentsRepo.purchase.hasActive(
            { userId: user.id, planId: plan.id },
            { overlapping: plan.overlapping },
          )
        : paymentsRepo.subscription.hasActive(
            { userId: user.id },
            { name: plan.name },
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

    // whether a retired plan still grants access to those who hold it is a policy choice
    const holds = active && (plan.active || RETIRED_PLANS_KEEP_ACCESS);

    // a retired plan is only revealed to someone who still holds it, or to an admin (read:all) -
    // anyone else gets the same 404 as a plan that never existed, matching GET /plans/:id
    if (!plan.active && !holds) {
      let authorized = false;
      await requirePermissionMiddleware({ plan: ["read:all"] })(
        c as unknown as Parameters<ReturnType<typeof requirePermissionMiddleware>>[0],
        async () => {
          authorized = true;
        },
      );
      if (!authorized) return c.json({ message: "Plan not found" }, HTTP.NotFound);
    }

    return c.json({ data: { active: holds }, message: "Access checked" }, HTTP.OK);
  })
  .get("/access", async (c) => {
    const { user } = c.get("session");
    const [res, error] = await tryCatch(
      paymentsRepo.access.getActivePlans({ userId: user.id }),
    );
    if (error) {
      c.var.logger.error({ err: error, user: user.id }, "payments.access.getActivePlans");
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
          ? paymentsRepo.audit.getByUser({ userId: targetUserId }, pageOptions)
          : paymentsRepo.audit.getAll(pageOptions),
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
          ? paymentsRepo.purchase.getByUserAdmin({ userId: targetUserId }, pageOptions)
          : paymentsRepo.purchase.getAllAdmin(pageOptions),
      );

      if (error) {
        c.var.logger.error({ err: error, user: user.id }, "payments.purchase.getAllAdmin");
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

      if (data.repeatable === true || data.durationDays != null || data.trialDays != null) {
        const [plan, planError] = await tryCatch(paymentsRepo.plan.get({ id }));
        if (planError) {
          c.var.logger.error({ err: planError, user: user.id, plan: id }, "payments.plan.update");
          return c.json(
            { message: "Something went wrong. Try again later." },
            HTTP.InternalServerError,
          );
        }

        if (!plan) return c.json({ message: "Plan not found" }, HTTP.NotFound);

        // mirrors insertPlanSchema's own type/field refinements, which only run at creation -
        // null is allowed either way (clearing a field is harmless); only a value set on the
        // wrong plan type is rejected
        if (data.durationDays != null && plan.type !== "one_time")
          return c.json(
            { message: "durationDays only applies to one-time plans" },
            HTTP.UnprocessableEntity,
          );

        if (data.trialDays != null && plan.type !== "recurring")
          return c.json(
            { message: "trialDays only applies to recurring plans" },
            HTTP.UnprocessableEntity,
          );

        // flipping false -> true would silently reopen repeat purchases for every user a
        // blocking purchase already locked out of buying this plan again
        if (data.repeatable === true && plan.type === "one_time" && !plan.repeatable) {
          const [blocked, blockedError] = await tryCatch(
            paymentsRepo.purchase.hasAnyBlocking({ planId: id }),
          );
          if (blockedError) {
            c.var.logger.error(
              { err: blockedError, user: user.id, plan: id },
              "payments.plan.update",
            );
            return c.json(
              { message: "Something went wrong. Try again later." },
              HTTP.InternalServerError,
            );
          }

          if (blocked)
            return c.json(
              {
                message:
                  "Can't make this plan repeatable - it already has a purchase that would be reopened to repeat buys",
              },
              HTTP.Conflict,
            );
        }
      }

      const [res, error] = await tryCatch(paymentsRepo.plan.update({ id }, data));

      if (error) {
        c.var.logger.error({ err: error, user: user.id, plan: id }, "payments.plan.update");
        return c.json(
          { message: "Something went wrong. Try again later." },
          HTTP.InternalServerError,
        );
      }

      if (!res) return c.json({ message: "Plan not found" }, HTTP.NotFound);

      // retiring/reactivating also archives/restores the plan's Stripe prices, so it can't be
      // sold through anything outside this app (the Customer Portal, a Payment Link, ...).
      // Idempotent, so repeating the same PATCH completes a sync that failed here
      if (data.active !== undefined) {
        const [, syncError] = await tryCatch(
          (async () => {
            await paymentsRepo.plan.syncPricesActive(res);
            // archiving stops new checkouts, but one opened before retirement would stay
            // payable for up to 24h - expire those too, per RETIRING_EXPIRES_OPEN_CHECKOUTS
            if (!res.active && RETIRING_EXPIRES_OPEN_CHECKOUTS)
              await paymentsRepo.plan.expireOpenCheckouts(res);
          })(),
        );
        if (syncError) {
          c.var.logger.error(
            { err: syncError, user: user.id, plan: id },
            "payments.plan.sync_prices",
          );
          return c.json(
            {
              message:
                "Plan updated, but Stripe couldn't be fully updated. Retry the same change.",
            },
            HTTP.InternalServerError,
          );
        }
      }

      return c.body(null, HTTP.NoContent);
    },
  )
  .post(
    "/checkout",
    jsonValidator(checkoutSchema),
    async (c) => {
      const { user } = c.get("session");
      const { data } = c.req.valid("json");
      const serverError = () =>
        c.json({ message: "Something went wrong. Try again later." }, HTTP.InternalServerError);
      const slotTaken = () =>
        c.json(
          { message: "You already have a checkout in progress for this plan" },
          HTTP.Conflict,
        );
      const beingDeleted = () =>
        c.json({ message: "This account is being deleted" }, HTTP.Conflict);

      const [plan, planError] = await tryCatch(paymentsRepo.plan.get({ id: data.planId }));

      if (planError) {
        c.var.logger.error(
          { err: planError, user: user.id, plan: data.planId },
          "payments.checkout.create",
        );
        return serverError();
      }

      if (!plan || !plan.active)
        return c.json({ message: "Plan not found" }, HTTP.NotFound);

      // subscriptions go through better-auth's /api/auth/subscription/upgrade
      if (plan.type !== "one_time")
        return c.json(
          { message: "Plan is not a one-time plan" },
          HTTP.UnprocessableEntity,
        );

      // fail fast once the user's deletion has started (see lib/deletion-guard.ts); the re-check
      // after the session exists, further down, is what closes the race
      const [deleting, deletingError] = await tryCatch(
        paymentsRepo.checkout.isUserDeleting(user.id),
      );
      if (deletingError) {
        c.var.logger.error(
          { err: deletingError, user: user.id },
          "payments.checkout.deletion_guard",
        );
        return serverError();
      }
      if (deleting) return beingDeleted();

      // what this request holds while it talks to Stripe, freed in `release` if it has to be: for
      // a non-repeatable plan, the (user, plan) slot itself (released only on failure -
      // savePendingCheckout replaces it with the session on success); for a repeatable plan, a
      // lock that just keeps concurrent creations for the same (user, plan) to one (always freed)
      let reservation: string | null = null;
      let createLock: string | null = null;
      const release = async () => {
        const [, releaseError] = await tryCatch(
          (async () => {
            if (reservation)
              await paymentsRepo.checkout.releaseReservation(user.id, plan.id, reservation);
            if (createLock)
              await paymentsRepo.checkout.releaseCreateLock(user.id, plan.id, createLock);
          })(),
        );
        // best-effort: an unreleased reservation or lock frees itself after RESERVATION_TTL_SEC
        if (releaseError)
          c.var.logger.warn(
            { err: releaseError, user: user.id, plan: plan.id },
            "payments.checkout.release_reservation",
          );
      };

      // the user's still-open session for this plan, if any - sent back instead of creating a
      // second one (see getResumableCheckout)
      const resume = async () => {
        const [resumable, resumeError] = await tryCatch(
          paymentsRepo.checkout.getResumable(user.id, plan.id),
        );
        if (resumeError)
          c.var.logger.warn(
            { err: resumeError, user: user.id, plan: plan.id },
            "payments.checkout.resume",
          );
        return resumable
          ? c.json({ data: resumable, message: "Checkout resumed" }, HTTP.OK)
          : null;
      };

      // whether the user already owns this non-repeatable plan, answering 409 (or 500) if so
      const blockIfOwned = async () => {
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
          return serverError();
        }

        if (!existing) return null;

        const [, auditError] = await tryCatch(
          paymentsRepo.audit.add({
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
      };

      if (!plan.repeatable) {
        // fast path: an owner is turned away before touching Redis at all
        const blocked = await blockIfOwned();
        if (blocked) return blocked;

        // an atomic claim, not a check-then-create: two concurrent requests can't both get
        // past this and both reach Stripe
        const [token, pendingError] = await tryCatch(
          paymentsRepo.checkout.reserve(user.id, plan.id),
        );

        if (pendingError) {
          c.var.logger.error(
            { err: pendingError, user: user.id, plan: plan.id },
            "payments.checkout.create",
          );
          return serverError();
        }

        if (!token) {
          // the usual reason the slot is held: this buyer opened a checkout and closed the tab.
          // Send them back to that same session rather than locking them out until it expires
          // (up to 24h) - it's still one checkout for the (user, plan) slot, so nothing about the
          // non-repeatable guard is weakened. A processing (already paid) session or an in-flight
          // reservation isn't resumable and still 409s below.
          const resumed = await resume();
          if (resumed) return resumed;

          const [, auditError] = await tryCatch(
            paymentsRepo.audit.add({
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
          return slotTaken();
        }
        reservation = token;

        // checked again now the slot is ours: the user's previous checkout can confirm between
        // the check above and the reservation - confirmCheckout inserts its purchase and only
        // then frees the slot, so the reservation can succeed for a plan they now own. That
        // ordering is also what makes this second check sufficient: once the slot is free, the
        // purchase is already visible
        const blockedAfterReserve = await blockIfOwned();
        if (blockedAfterReserve) {
          await release();
          return blockedAfterReserve;
        }
      } else {
        // a repeatable plan can be bought again, but an open, unpaid session for it is reused
        // rather than piling up new ones - each costs Stripe API calls the webhook handler shares
        const resumed = await resume();
        if (resumed) return resumed;

        const [token, lockError] = await tryCatch(
          paymentsRepo.checkout.acquireCreateLock(user.id, plan.id),
        );
        if (lockError) {
          c.var.logger.error(
            { err: lockError, user: user.id, plan: plan.id },
            "payments.checkout.create",
          );
          return serverError();
        }
        if (!token) return slotTaken();
        createLock = token;
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
        await release();
        return serverError();
      }

      const [res, error] = await tryCatch(
        paymentsRepo.checkout.create(
          { userId: user.id, stripeCustomerId },
          plan,
          { reservation: reservation ?? undefined },
        ),
      );

      if (error) {
        // the reservation lapsed while Stripe answered and another checkout took the slot -
        // createCheckout already withheld (and expired) this one
        if (error instanceof CheckoutSlotLostError) {
          c.var.logger.warn({ user: user.id, plan: plan.id }, "payments.checkout.slot_lost");
          await release();
          return slotTaken();
        }
        c.var.logger.error(
          { err: error, user: user.id, plan: plan.id },
          "payments.checkout.create",
        );
        // only releases if the pointer still holds this request's reservation: if the Stripe
        // session was created but saving it to Redis failed, the reservation is all that's left
        // guarding the slot, and releasing it is no worse than the pre-reservation behavior
        await release();
        return serverError();
      }
      // a non-repeatable reservation now holds the session itself; only the create lock is freed
      reservation = null;
      await release();

      // the deletion flag again, now the session exists: a deletion that started after the check
      // above may have listed the user's open sessions before this one existed, so it's this
      // request's job to expire it (see lib/deletion-guard.ts)
      const [deletingNow, recheckError] = await tryCatch(
        paymentsRepo.checkout.isUserDeleting(user.id),
      );
      // a Redis failure here almost certainly failed the deletion hook's own flag write too, which
      // aborts the deletion - so the checkout goes through rather than failing a normal purchase
      if (recheckError)
        c.var.logger.warn(
          { err: recheckError, user: user.id },
          "payments.checkout.deletion_guard",
        );
      if (deletingNow) {
        const [, expireError] = await tryCatch(paymentsRepo.checkout.expire(res.sessionId));
        // its URL is withheld either way, so nobody can pay it
        if (expireError)
          c.var.logger.error(
            { err: expireError, user: user.id, session: res.sessionId },
            "payments.checkout.deletion_guard.expire",
          );
        return beingDeleted();
      }

      return c.json(
        { data: res, message: "Checkout created" },
        HTTP.OK,
      );
    },
  );

export default app;
