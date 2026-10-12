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
| GET | `/plans` | any signed-in user | active plans only |
| POST | `/plans` | admin (`plan:create`) | creates the Stripe product + price(s), then the DB row |
| GET | `/purchases` | caller | their own one-time purchases |
| POST | `/checkout` | caller | one-time plans only — `recurring` 422s |
| GET | `/checkout/:sessionId` | caller | `open`/`processing`/`paid`/`refunded`/`disputed` |

The webhook (`/api/auth/stripe/webhook` → `handleStripeEvent` in `lib/webhook.ts`) writes and syncs `purchase` rows; `bun run payments:reconcile [--days 7] [--dry-run]` backfills anything a missed webhook left behind.

**Only need one of the two flows?**
- *Drop subscriptions:* remove (or `enabled: false`) `auth.ts`'s `subscription` option — the only thing gating it. Don't create `recurring` plans.
- *Drop one-time purchases:* delete the following, and don't create `one_time` plans.

| Delete | What it is |
| --- | --- |
| `lib/pending-checkout.ts` | Redis pending-checkout state |
| `use-cases/checkout.ts` | `createCheckout` / `getCheckoutStatus` |
| `lib/webhook.ts` | the Stripe webhook handler (also remove `auth.ts`'s `onEvent`) |
| `lib/constants.ts` | `ALLOWED_EVENTS` |
| one-time-only helpers in `lib/utils.ts` | `isAllowedEvent`, `isCheckoutSessionId`, `purchaseUpdateFromCharge`, `purchaseStatusFromDispute` |
| `scripts/reconcile.ts` | the webhook backstop |
| `purchase` use-cases + `GET /purchases` | `add-purchase.ts` / `get-purchases.ts` / `update-purchase.ts` |
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
