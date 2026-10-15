# syntax=docker/dockerfile:1
#
# Single-container image: the Fastify server serving the built web app.
# On start it applies pending database migrations, then runs the server.
# See docs/DEPLOYMENT.md.
#
#   docker build -t civ-jar .
#   export OPERATOR_TOKEN=$(openssl rand -hex 32)
#   docker compose --profile app up -d --build     (with the PostgreSQL service)

ARG NODE_VERSION=22.22.0

# ---------------------------------------------------------------------------
# base: Node + pnpm (via corepack, version pinned by package.json "packageManager")
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# OpenSSL lets Prisma detect the right engine build (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# build: install with the frozen lockfile, build every package, assemble the server
FROM base AS build
# Manifests first so the dependency layer stays cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sim-core/package.json packages/sim-core/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
# The server's postinstall runs `prisma generate`, which needs the schema.
COPY apps/server/prisma apps/server/prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY . .
# Topological order: sim-core and shared first (their dist/ is what the server imports at
# run time, via the "default" export condition), then the server (tsc) and web (vite).
RUN pnpm -r build

# /out/app: a self-contained copy of the server with its own node_modules, in which
# @civ/sim-core and @civ/shared are copied packages (package.json + dist/ only).
# Production dependencies only; they include the Prisma CLI used by `migrate deploy` at
# start-up (see docs/DEPLOYMENT.md, "Image contents").
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@civ/server deploy --legacy --prod --store-dir /pnpm/store /out/app \
 && cd /out/app \
 && rm -rf dist prisma src test tsconfig.json tsconfig.build.json vitest.config.ts \
 && cp -r /repo/apps/server/dist /repo/apps/server/prisma ./ \
 && node ./node_modules/prisma/build/index.js generate \
 && cp -r /repo/apps/web/dist ./web \
 && install -m 0555 /repo/scripts/docker-entrypoint.sh ./docker-entrypoint.sh

# ---------------------------------------------------------------------------
# runtime: server + web assets, running as the unprivileged `node` user
FROM base AS runtime
# No auth settings are baked in. With HOST=0.0.0.0 the server refuses to start until
# AUTH_MODE=token and OPERATOR_TOKEN are provided at run time (AUTH_MODE=disabled is
# accepted on loopback addresses only), so the image cannot start unprotected.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    WEB_DIST_DIR=/app/web
WORKDIR /app
# Owned by root and read-only for `node`: the process never writes to its own files.
COPY --from=build /out/app /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
