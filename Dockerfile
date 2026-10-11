# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# separate layer so `bun install` is only re-run when the lockfile changes,
# not on every source edit
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# must match SERVER_PORT
EXPOSE 8000

# the `bun` user is built into the official image
USER bun
ENTRYPOINT ["bun", "run", "start"]
