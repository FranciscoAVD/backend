# backend

A Hono + better-auth + Drizzle API template, built on Bun.

## Stack

- **Runtime:** Bun
- **Framework:** Hono
- **Auth:** better-auth (email/password, admin plugin, access-control roles)
- **Payments:** Stripe — admin-created plans, subscriptions and one-time Checkout via better-auth's stripe plugin
- **Database:** Postgres via Drizzle ORM (`drizzle-orm/bun-sql`)
- **Cache / rate limiting:** Redis via `Bun.redis`
- **Logging:** pino, shared by request logging (`hono-pino`) and app/error logging — structured JSON in production, pretty-printed in development, level set via `LOG_LEVEL`. Every request gets an id (`hono/request-id`, returned as `X-Request-Id`) that's attached to its log lines as `reqId`, so one request's lines can be grepped together.

## Payments

Always on — `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are required env vars, not feature-flagged. A `plan` is either `recurring` (a subscription) or `one_time`; which kind decides who handles it:

- **Subscriptions** are entirely better-auth's stripe plugin — `subscription.plans` resolves active recurring plans from the `plan` table, and the plugin owns its own checkout/upgrade endpoints (`/api/auth/subscription/*`) and `subscription` table. This app doesn't touch that flow directly.
- **One-time purchases** are this app's own: `POST /payments/checkout` creates a Stripe Checkout Session for a `one_time` plan and tracks it as "pending" in Redis (`pending-checkout.ts`) until Stripe confirms payment — no `purchase` row exists yet at that point. `GET /payments/checkout/:sessionId` reports `open`/`processing` from that pending entry, or the confirmed `purchase` row's status once it exists.

**Endpoints** (`/api/payments`, session-gated; see `route.ts`):

| | Route | Who | Notes |
| --- | --- | --- | --- |
| GET | `/plans` | any signed-in user | active plans only |
| POST | `/plans` | admin (`plan:create`) | creates the Stripe product + price(s) first, then the DB row; archives the Stripe product if anything after fails (see `add-plan.ts`) |
| GET | `/purchases` | caller | their own one-time purchases only |
| POST | `/checkout` | caller | one-time plans only — a `recurring` plan 422s, pointing at better-auth's subscription endpoint instead |
| GET | `/checkout/:sessionId` | caller | `open` / `processing` / the `purchase` row's `paid` / `refunded` / `disputed` |

**The webhook** (`/api/auth/stripe/webhook`, better-auth's own path → `handleStripeEvent` in `lib/webhook.ts`) is what actually writes `purchase` rows and keeps them in sync: records a completed one-time checkout (resolving the owner from the Redis pending entry, falling back to the Checkout Session's own metadata if that's gone), and applies refund/dispute events to the matching purchase by payment intent. A refund/dispute for a purchase that isn't recorded yet (still in flight) makes the handler throw deliberately, so better-auth answers Stripe with an error and it retries the event later instead of silently dropping it.

**`bun run payments:reconcile [--days 7] [--dry-run]`** is the backstop for webhooks that never arrive (an outage, Stripe gave up retrying): it scans recent Stripe Checkout Sessions directly and inserts/updates `purchase` rows to match, using the same logic the webhook uses.

### Want just subscriptions, just one-time purchases, or neither?

**Drop subscriptions, keep one-time purchases:** remove the `subscription` option from `auth.ts`'s `stripe(...)` call entirely, or set `subscription: { enabled: false }` — identical effect either way. That one option is the only thing gating `/api/auth/subscription/*` and the plugin's own `subscription` table; nothing else in this app references subscription state. Just don't create `type: "recurring"` plans afterward.

**Drop one-time purchases, keep subscriptions:** `lib/constants.ts`'s `ALLOWED_EVENTS` is *not* the lever for this — emptying it only stops the webhook from ever confirming a payment, while `POST /payments/checkout` stays live and would still create real Stripe Checkout Sessions and charge real cards. The safe way is to delete the flow outright: `lib/pending-checkout.ts`, `use-cases/checkout.ts`, `lib/webhook.ts` (and `auth.ts`'s `onEvent: handleStripeEvent`), `lib/constants.ts`, the one-time-only functions in `lib/utils.ts` (`isAllowedEvent`, `isCheckoutSessionId`, `purchaseUpdateFromCharge`, `purchaseStatusFromDispute`), `scripts/reconcile.ts`, the `purchase`-table use-cases (`add-purchase.ts`/`get-purchases.ts`/`update-purchase.ts`) and `GET /purchases`, and the `/checkout` + `/checkout/:sessionId` handlers in `route.ts`. Don't create `type: "one_time"` plans afterward (or drop that variant from the `type` enum).

**Want both:** nothing to change — this is the default.

## Folder structure

```
.
├── src/                    # see below
├── compose.yaml            # Postgres + Redis for local dev
├── Dockerfile              # production image
├── drizzle.config.ts
├── .env.example
└── package.json
```

```
src/
├── index.ts          # entry point: mounts /health + the /api router, exports AppType
├── env.ts            # validated env vars (@t3-oss/env-core + zod)
├── db/
│   ├── connection.ts  # the `db` (Drizzle) singleton
│   ├── url.ts         # DB_URL, assembled from DB_* or taken as-is - never both
│   └── schemas/       # one file per Drizzle table, grouped by feature
├── lib/              # app-level (cross-feature) utilities
│   ├── health.ts
│   ├── logger.ts      # the pino instance
│   ├── redis.ts       # the `redis` singleton
│   ├── rate-limit.ts  # @vicstack/rate-limit wired to `redis`
│   ├── validators.ts  # shared Hono validators (idParamValidator, jsonValidator)
│   └── tests/
├── test-helpers/     # shared test fixtures (resetDb, seedUser, resetRedis, ...)
└── features/
    ├── auth/          # better-auth config + session/permission middleware
    │   ├── auth.ts
    │   ├── middleware.ts
    │   ├── route.ts
    │   └── lib/
    ├── todo/          # the reference feature for the layout below
    └── payments/      # the same layout, plus payment.ts (Stripe client) and scripts/
```

Every feature under `features/` (see `todo/` as the reference, and `CLAUDE.md`'s Resource conventions for the full writeup) follows the same shape:

```
features/<feature>/
├── route.ts             # one Hono router, chained in a single expression (see CLAUDE.md)
├── repo.ts               # barrel: every use-case re-exported as one grouped object
├── use-cases/            # one DB operation per file (add/get/update/delete)
├── lib/                  # schemas, types, feature-local helpers
└── tests/                # mirrors use-cases/ and lib/, one tests/ folder per feature
```

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

## Running with Docker

`docker build -t backend .` produces a production image. It expects every env var in `.env.example` to be set — e.g. `--env-file .env` — and listens on `SERVER_PORT`. The image's `HEALTHCHECK` hits `GET /health` (see below) with Bun's own `fetch`, so no curl/wget needs adding to the alpine base. `compose.yaml` only provisions Postgres and Redis for local dev; it doesn't define a service for this image.

## Health check

`GET /health` (unauthenticated, outside `/api`) confirms Postgres and Redis are actually reachable, not just that the process is up — `200 {"status":"ok"}`, or `503` naming which dependency failed. It skips the whole `/api` middleware stack, including request logging, since a liveness/readiness probe firing every few seconds shouldn't spam the access log.

## Client usage

`src/index.ts` exports `AppType`, so a TS client gets full request/response type inference for free via `hono/client`, no codegen or OpenAPI spec needed:

```ts
import { hc } from "hono/client";
import type { AppType } from "../backend/src"; // wherever this repo lives relative to the client

const client = hc<AppType>("http://localhost:8000");
const res = await client.api.todo.$get();
```

Covers `/todo` and `/payments`. `/auth` is in there too but untyped — use better-auth's own client (`createAuthClient`) for that surface instead.

## Logs in production

In production, pino writes structured JSON to stdout and keeps nothing itself. To make logs durable, ship stdout from the platform rather than from the app: a Docker logging driver, a Kubernetes collector (Fluent Bit, Vector), or a host's log drain, into a store such as Loki, Elasticsearch/OpenSearch, CloudWatch, Datadog or Axiom. Set retention in that store. The app stays unaware of where its logs go.

If a project needs the app to ship logs itself, add a pino transport (`pino-roll` for rotating files, `pino-loki`, `pino-elasticsearch`, `@axiomhq/pino`, …) in `src/lib/logger.ts`, next to the dev-only `pino-pretty` one. The right target varies per deployment, so the template doesn't pick one.

Shipped logs make a convenience-grade audit trail: good for "who did what last Tuesday", but not for compliance.
