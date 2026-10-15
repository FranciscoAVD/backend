# backend

A Hono + better-auth + Drizzle API template, built on Bun.

## Stack

- **Runtime:** Bun
- **Framework:** Hono
- **Auth:** better-auth (email/password, admin plugin, access-control roles)
- **Payments:** Stripe — admin-created plans, subscriptions and one-time Checkout via better-auth's stripe plugin
- **Database:** Postgres via Drizzle ORM (`drizzle-orm/bun-sql`)
- **Cache / rate limiting:** Redis via `Bun.redis`
- **Logging:** pino (`hono-pino` for requests), structured in prod, pretty in dev. Every request's log lines carry a `reqId` (`hono/request-id`).

## Payments

A `plan` is `recurring` (a subscription managed by better-auth's stripe plugin) or `one_time` (this app's own Checkout flow, tracked pending in Redis until the webhook confirms it and writes a `purchase` row).

**Endpoints** (`/api/payments`, session-gated; see `route.ts`):

| | Route | Who | Notes |
| --- | --- | --- | --- |
| GET | `/plans` | `plan:read:active`, `plan:read:all` for inactive ones too | active plans only, unless the caller also has `read:all` |
| GET | `/plans/:id` | `plan:read:active`, or `plan:read:all` for an inactive one | 404s an inactive plan for anyone without `read:all` - not 403, so its existence isn't revealed |
| GET | `/plans/:id/access` | caller | whether the caller currently has active access — a `purchase` row for one-time plans, an active/trialing `subscription` row for recurring ones. A retired plan 404s unless the caller still holds it or has `read:all` |
| GET | `/access` | caller | every plan the caller currently has access to, across both types, each with its `limits` |
| POST | `/plans` | admin (`plan:create`) | creates the Stripe product + price(s), then the DB row |
| PATCH | `/plans/:id` | admin (`plan:update`) | `limits`/`active`/`repeatable`/`durationDays`/`overlapping`/`trialDays` only - pricing/identity fields are fixed once created; "deleting" a plan is `{ active: false }` |
| GET | `/audit-log` | admin (`audit:list`) | every entry, or `?userId=` for one customer's; paginated with `?limit=` (≤100) and `?before=<nextCursor>` |
| GET | `/purchases` | caller | their own one-time purchases, each with the chained access window it actually grants (`accessStartsAt`/`accessEndsAt`) alongside its own unchained `expiresAt` |
| GET | `/purchases/all` | admin (`purchase:read:all`) | every purchase, or `?userId=` for one customer's; paginated the same way as `/audit-log` |
| POST | `/checkout` | caller | one-time plans only — `recurring` 422s |
| GET | `/checkout/:sessionId` | caller | `open`/`processing`/`failed`/`expired`/`paid`/`refunded`/`disputed` |

The webhook (`/api/auth/stripe/webhook` → `handleStripeEvent` in `lib/webhook.ts`) writes and syncs `purchase` rows; `bun run payments:reconcile [--days 14] [--dry-run]` backfills anything a missed webhook left behind *and* corrects any `subscription` row left stale by an out-of-order webhook event. See `CONTROL_FLOW.md` for the full request/webhook/reconciler control flow, including the `plan.repeatable`/`durationDays`/`overlapping` races and the `payment_audit_log` trail they write to.

**Product decisions** — whether `past_due` keeps access, whether a partial refund or an open dispute ends it, whether a retired plan's holders keep it, and how a deleted user's subscriptions are cancelled — are named constants in `lib/access-policy.ts`, with the defaults and alternatives documented there and in `CONTROL_FLOW.md`. Change them there rather than in the queries that read them.

**Adding Stripe params** (promo codes, tax, different line items, ...) to the one-time checkout: implement `getCheckoutSessionParams` in `lib/checkout-extensions.ts` — a no-op by default, mirroring `@better-auth/stripe`'s own `subscription.getCheckoutSessionParams` option for the subscription flow. See that file and `CONTROL_FLOW.md` for exactly which fields always win over what it returns, and note that changing `line_items` changes what's charged, not what's granted: one checkout is one purchase with one access window, whatever the quantity.

**Running the reconciler on a schedule.** The `Dockerfile`'s `cron` stage is a separate image, built from the same source, whose only job is running `payments:reconcile` daily via busybox `crond` - `crond` itself runs as root (it has to, to manage `/etc/crontabs`), but drops to the unprivileged `bun` user for the scheduled job itself, so the reconciler - which holds the Stripe secret key and database credentials - never runs as root (see the `cron` stage's comments for why, and why the crontab redirects to `/proc/1/fd/1-2`). Build and run it like:

```sh
docker build --target cron -t backend-reconcile-cron .
docker run -d --restart unless-stopped --env-file .env backend-reconcile-cron
```

Give it the same env vars as the main app (`DB_URL`/`DB_*`, `REDIS_URL`, `STRIPE_SECRET_KEY`, ...), pointed at production - not the main app's own container or the `postgres`/`redis` services in `compose.yaml`, which are local-dev-only. To change the schedule, edit the `0 3 * * *` line in the Dockerfile and rebuild - there's no env var for it.

**Only need one of the two flows?**
- *Drop subscriptions:* remove (or `enabled: false`) `auth.ts`'s `subscription` option — the only thing gating it. Don't create `recurring` plans. The `hooks.before` retired-plan guard and the user-deletion hook become no-ops (no recurring plans, no subscriptions to cancel), so they can stay or go.
- *Drop one-time purchases:* delete the following, and don't create `one_time` plans.

| Delete | What it is |
| --- | --- |
| `lib/pending-checkout.ts` | Redis pending-checkout state |
| `use-cases/checkout.ts` | `createCheckout` / `getCheckoutStatus` |
| `lib/webhook.ts` | the Stripe webhook handler (also remove `auth.ts`'s `onEvent`) |
| `lib/charge-state.ts` | `resolveChargeState`, shared by the webhook and the reconciler |
| `lib/constants.ts` | `ALLOWED_EVENTS` |
| one-time-only helpers in `lib/utils.ts` | `isAllowedEvent`, `isCheckoutSessionId`, `isForeignKeyViolation`, `purchaseUpdateFromCharge`, `purchaseStatusFromDispute`, `encodeDurationDays`, `decodeDurationDays` |
| `lib/reconcile.ts` + `scripts/reconcile.ts` | the webhook backstop |
| `purchase` use-cases + `GET /purchases` | `add-purchase.ts` / `get-purchases.ts` / `sync-purchase-charge.ts` |
| the audit log | `use-cases/add-audit-log.ts` / `get-audit-log.ts`, the `payment_audit_log` table |
| `/checkout` + `/checkout/:sessionId` | the routes in `route.ts` that start/check a checkout |

## Folder structure

Every feature under `features/` follows the same shape (see `todo/` as the reference, `CLAUDE.md`'s Resource conventions for the full writeup):

```
features/<feature>/
├── route.ts        # one Hono router, chained in a single expression (see CLAUDE.md)
├── repo.ts          # barrel: every use-case re-exported as one grouped object
├── use-cases/       # one DB operation per file (add/get/update/delete)
├── lib/             # schemas, types, feature-local helpers
└── tests/           # mirrors use-cases/ and lib/
```

Cross-feature code lives in `src/lib/` (logger, redis, rate-limit, validators, the health route), `src/db/` (connection + one schema file per feature), and `src/test-helpers/` (shared test fixtures).

## Local development

```sh
cp .env.example .env      # fill in BETTER_AUTH_SECRET, DB_*, etc.
docker compose up -d      # Postgres + Redis
bun install
bun run dev                # bun run --hot src/index.ts
```

Seed an admin user with `./src/features/auth/lib/seed-admin.sh` (creates `admin@verified.com` with the `admin` role via better-auth's CLI).

## Testing

```sh
docker compose exec postgres psql -U admin -d backend -c "CREATE DATABASE backend_test"   # one-time
bun run db:test:push   # re-run after schema changes
bun run test
```

## Docker

`docker build -t backend .` builds a production image expecting every `.env.example` var set (`--env-file .env`). Its `HEALTHCHECK` hits `GET /health` via Bun's own `fetch`. `compose.yaml` only provisions Postgres/Redis for dev — no service for this image.

## Health check

`GET /health` (outside `/api`, unauthenticated, unlogged) confirms Postgres and Redis are actually reachable — `200` or `503` naming which failed.

## Client usage

`src/index.ts` exports `AppType` for full request/response type inference via `hono/client`, no codegen needed:

```ts
import { hc } from "hono/client";
import type { AppType } from "../backend/src";

const client = hc<AppType>("http://localhost:8000");
const res = await client.api.todo.$get();
```

Covers `/todo` and `/payments`. For `/auth`, use better-auth's own client instead.

## Logs in production

Pino writes JSON to stdout; the app doesn't ship or store logs itself — pick that up from the platform (Docker logging driver, a k8s collector, etc.). This is a convenience trail ("who did what last Tuesday"), not a compliance one.

## License

MIT — see [LICENSE](./LICENSE).
