# Auditing

As of 2026-10-08.

The template deliberately has no audit table. What to audit, how long to keep it, and which personal data it may hold depend on the project and its compliance needs (SOC 2, HIPAA, PCI, GDPR, …), so a generic table would either audit too little to satisfy anyone or too much to be useful. This note records the design worked out for the template, to start from when a project needs one.

## What already exists

- **Logs:** pino logs with dot-scoped names and context. Once shipped to a log store (see the README's *Logs in production*), they answer convenience questions. They aren't a compliance trail: a log line isn't written in the same transaction as the change it describes, so a crash or a sink outage can lose entries for changes that did happen; `LOG_LEVEL` can filter them out; and only the store decides whether entries can be edited.
- **Stripe:** every payment event is in the Dashboard and the Events API (the API keeps 30 days).
- **better-auth:** the `session` table records IP and user agent per sign-in.

## Designing the table

Answer these per project first:

1. **Scope:** which actions are worth recording. Payments and admin actions usually matter most; routine CRUD (e.g. todos) rarely does.
2. **Atomicity:** must every change have an entry (same transaction), or is a logged, best-effort write acceptable?
3. **Readers:** an admin endpoint, or direct database queries only.
4. **Retention and personal data:** how long entries are kept, and whether a deleted user's IP/user agent must be scrubbed while the action and IDs stay.

### Layout

Follow the `features/todo` pattern: the table in `src/db/schemas/audit-schema.ts`, and `features/audit/` with `lib/{schemas,types}.ts`, `use-cases/{add,get}.ts` and, if it's read through the API, `routes/audit.ts`.

Entries are **append-only**: no update or delete use-cases and no `updateAuditSchema`. That's an intended exception to the Insert/Update/Select convention in `CLAUDE.md`; note it there when adding the feature.

### Columns

| Column | Notes |
| --- | --- |
| `id` | identity |
| `actorID` | text, nullable; no foreign key (see below) |
| `actorType` | enum: `user` / `admin` / `system` / `stripe` |
| `action` | dot-scoped like log names: `purchase.refund`, `plan.create`, `user.ban` |
| `resourceType`, `resourceID` | the affected record; `resourceID` as text so any ID type fits |
| `metadata` | jsonb: before/after values or event details (e.g. the Stripe event ID) |
| `ip`, `userAgent` | request context; null for webhooks and scripts |
| `createdAt` | timestamp |

Index `(resourceType, resourceID)`, `actorID` and `createdAt`.

**No foreign key or cascade on the actor.** Todos cascade-delete with their user; audit rows must not, since the history has to outlive the user. In exchange, IP and user agent outlive the account, which is what the retention question above is about.

### Writing entries

- **Explicit calls in use-cases** (recommended): an `addAuditEntry(...)` use-case called from the audited paths. It gives meaningful action names and before/after data, and works the same from routes, the Stripe webhook and scripts like `payments:reconcile`. The cost is that every audited path has to remember to call it.
- Generic middleware on mutating routes records requests rather than meaning, and misses the webhook and scripts. Postgres triggers catch every change but have no actor or request context without session-variable plumbing, and fit Drizzle awkwardly. Neither is recommended.
- **Auth events** (sign-in, password change, role change, ban, impersonation): use better-auth's hooks (`databaseHooks`, or after-hooks on the endpoints) instead of our routes, since better-auth owns those writes.

**Actor and request context** are passed explicitly as an `actor` argument, as use-cases take `user` today, rather than read implicitly through Hono's `contextStorage()`. The webhook and scripts have no request, and explicit arguments are easier to test.

### Atomicity

For an entry that can't be missing, write it in the same transaction as the change: `db.transaction(async (tx) => { ... })`, with the audited use-cases accepting the transaction instead of always using `db`. This relaxes the README's "each use-case does one DB operation" rule for those paths; the transaction, not the use-case, becomes the unit. Auth events can only be written after the fact, since better-auth's writes aren't in our transactions.

If best-effort is enough, write the entry after the change with `tryCatch` and log a failure; the action still succeeds.

### Reading entries

An admin-only `GET /audit` with filters (resource, actor, action, date range) and pagination, gated by a new `audit: ["read"]` permission in `src/features/auth/lib/permissions.ts` through `requirePermission`.
