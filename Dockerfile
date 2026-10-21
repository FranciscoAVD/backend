# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# separate layer so `bun install` is only re-run when the lockfile changes,
# not on every source edit
FROM base AS install
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY shared/package.json ./shared/package.json
RUN bun install --frozen-lockfile --production

FROM base AS release
# grabs whatever node_modules layout `bun install` produced (root-hoisted
# and/or per-workspace symlinks) without having to know which
COPY --from=install /app /app
COPY shared/src ./shared/src
COPY apps/backend/tsconfig.json ./apps/backend/tsconfig.json
COPY apps/backend/src ./apps/backend/src

ENV NODE_ENV=production
# must match SERVER_PORT
EXPOSE 8000

WORKDIR /app/apps/backend

# no curl/wget on alpine — Bun's own fetch avoids adding a package just for this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# the `bun` user is built into the official image
USER bun
ENTRYPOINT ["bun", "run", "start"]

# A second image from the same build, for a separate deployment that just runs
# payments:reconcile on a schedule - a backstop for Stripe webhooks that never
# arrived (see payments/CONTROL_FLOW.md's "The reconciler" section). Build with
# `docker build --target cron -t <name> .`; run it with the same env vars
# (DB_URL/REDIS_URL/STRIPE_SECRET_KEY/...) as the main app, pointed at production.
FROM release AS cron

# busybox crond manages crontabs per-user from /etc/crontabs/<user> and must run
# as root to do so - but the job itself drops to the unprivileged `bun` user (via
# `su` below), so the reconciler, which holds the Stripe secret key and database
# credentials, never runs as root. Only crond does
USER root

COPY docker/reconcile-cron.sh /app/reconcile-cron.sh
RUN chmod +x /app/reconcile-cron.sh \
  # daily at 03:00 - the reconciler's own 28-day scan window easily tolerates a
  # missed run or two, so there's no need to run more often than that; redirecting
  # to /proc/1/fd/1-2 is what makes the job's output show up in `docker logs`,
  # since crond itself logs to syslog/stderr, not stdout, by default. The redirect
  # is opened by root's shell before `su` drops to `bun` (which couldn't open
  # PID 1's descriptors itself), and the job inherits it
  && echo "0 3 * * * su -s /bin/sh bun -c /app/reconcile-cron.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root

ENTRYPOINT ["crond", "-f", "-l", "2"]

# `cron` must come after `release` (it's built FROM it), but a plain `docker build .`
# with no `--target` builds whichever stage is *last* in the file - without this,
# that would silently be `cron`, not the server. This empty stage re-aliases
# `release` as the final one so the default build target is the server again;
# `--target cron` still reaches the stage above untouched.
FROM release
