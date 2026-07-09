# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# v1.4.43 B11 — version build-arg threaded into the layer cache key.
# Pre-v1.4.43 the docker-publish workflow shipped a stale package.json
# version baked into the bundle because BuildKit reused the `pnpm build`
# layer across releases (the COPY . . layer key was content-stable when
# only the version string had changed and the next pnpm install layer
# was warm). Passing the tag as a build-arg forces a per-release cache
# miss on this layer and forwards the value into the runtime env so
# /api/version reads from $NEXT_PUBLIC_APP_VERSION first.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION

# Short Git SHA of the release commit, same workflow source as the
# version arg above. Changes exactly when the source changes, so it
# adds no cache churn beyond what the COPY below already causes.
# /api/version surfaces it as `buildSha` for deploy verification
# (docs/ops/deploy.md). The built-at timestamp is intentionally NOT
# set in this stage: it differs on every run and would bust the
# `pnpm build` layer cache even for content-identical rebuilds — the
# runner stage below carries it instead (the route reads process.env
# at request time, not at bundle time).
ARG NEXT_PUBLIC_APP_BUILD_SHA
ENV NEXT_PUBLIC_APP_BUILD_SHA=$NEXT_PUBLIC_APP_BUILD_SHA

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN pnpm db:generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── Stage 3: Production runner ─────────────────────────────
FROM node:22-alpine AS runner
# `tzdata` is required so Europe/Berlin schedules (pg-boss cron, locale-aware
# timestamp formatting) resolve to the actual offset instead of silently
# falling back to UTC on Alpine images that ship without it.
RUN apk add --no-cache tzdata && \
    corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_PATH="/opt/pg-boss/node_modules"
ENV TZ=Europe/Berlin

# v1.4.43 B11 — forward NEXT_PUBLIC_APP_VERSION from the builder stage
# into the runner so /api/version reads the build-arg value instead of
# the package.json fallback. The variable is keyed to the CI tag ref
# (`v1.4.43`, etc.), so a release that bumps the tag but cache-reuses
# the prior `pnpm build` layer still surfaces the right runtime version.
ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION

# Short Git SHA the image was built from — /api/version returns it as
# `buildSha` so an operator can verify which commit a running `:latest`
# container actually carries (the deploy runbook checks it after every
# deploy). Provided by docker-publish.yml alongside the version arg.
ARG NEXT_PUBLIC_APP_BUILD_SHA
ENV NEXT_PUBLIC_APP_BUILD_SHA=$NEXT_PUBLIC_APP_BUILD_SHA

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# @napi-rs/canvas (document PDF rasterization): Next's file tracer copies the
# native binary's package into the standalone tree but NOT the pnpm symlink that
# @napi-rs/canvas's loader resolves it through, so at runtime it fails with
# "Failed to load native binding" and rasterization silently degrades. Copy the
# prebuilt .node into the canvas package dir itself so the loader's built-in
# local-file fallback (`require('./skia.<triple>.node')`) resolves it. Per-arch
# buildx installs only the matching musl triple, so the find is arch-correct.
RUN CANVAS_DIR="$(find ./node_modules/.pnpm -maxdepth 4 -type d -path '*@napi-rs+canvas@*/node_modules/@napi-rs/canvas' 2>/dev/null | head -1)"; \
    NODE_BIN="$(find ./node_modules/.pnpm -maxdepth 5 -name 'skia.linux-*-musl.node' 2>/dev/null | head -1)"; \
    if [ -n "$CANVAS_DIR" ] && [ -n "$NODE_BIN" ]; then \
      cp "$NODE_BIN" "$CANVAS_DIR/" && chown nextjs:nodejs "$CANVAS_DIR/$(basename "$NODE_BIN")" && \
      echo "canvas native binding staged: $(basename "$NODE_BIN") -> $CANVAS_DIR"; \
    else echo "WARN: canvas native binding not found; PDF rasterization will degrade to local text"; fi

# Copy Prisma for migrations (schema, migration SQL, config, engines)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

# Install all worker runtime dependencies in a shared prefix.
# NODE_PATH makes them available to Node.js module resolution.
# These packages are listed in next.config.ts serverExternalPackages
# and are NOT bundled by Next.js — they must exist at runtime.
RUN mkdir -p /opt/pg-boss && \
    cd /opt/pg-boss && \
    npm init -y && \
    npm install --omit=dev pg-boss@12.18 @prisma/adapter-pg@7.8 pg@8.20

# Install Prisma CLI + engines for runtime migrations (isolated from Next standalone tree)
RUN mkdir -p /opt/prisma-cli && \
    cd /opt/prisma-cli && \
    npm init -y && \
    npm install --omit=dev prisma@7.8 @prisma/engines@7.8

# v1.4.27 B3 — offline GeoLite2 databases for IP→location and IP→ASN
# lookups. The MMDB files live in `/opt/geolite2/` and are read by
# `src/lib/geo.ts` via `mmdb-lib`. They are downloaded outside the
# Docker build by `scripts/fetch-geolite2.sh` (operator runs it before
# `docker build` with a MaxMind license key) and staged in
# `assets/geolite2/`. The README + .gitkeep are always present so the
# COPY target exists; if the maintainer skipped the fetch step the
# image builds without the DBs and the resolver falls back to the
# online `ipwho.is` provider — matches v1.4.26 behaviour.
#
# Attribution (CC BY-SA 4.0): see `docs/audit/v1427-summary.md` and
# `/about` in the running app.
RUN mkdir -p /opt/geolite2
COPY assets/geolite2/ /opt/geolite2/

# ISO-8601 build timestamp — /api/version returns it as `builtAt`.
# Declared this late in the stage on purpose: the value differs on
# every CI run, and every instruction after an ARG shares its cache
# fate. Down here the only layers it invalidates are the cheap
# entrypoint COPY/chmod below; the npm-install layers above stay
# cache-warm across rebuilds of the same release.
ARG NEXT_PUBLIC_APP_BUILT_AT
ENV NEXT_PUBLIC_APP_BUILT_AT=$NEXT_PUBLIC_APP_BUILT_AT

# Entrypoint script (runs migrations, then starts app)
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
