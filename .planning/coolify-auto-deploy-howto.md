# Coolify image-digest auto-deploy — maintainer runbook

Status: maintainer-task — the toggle lives in Coolify's UI; neither
the Coolify MCP nor the GitHub workflow can flip it.

## The problem

Releases v1.4.19, v1.4.20, and v1.4.21 all required a host-side
`docker tag <sha> :latest` + `docker compose up -d --no-deps` fallback
after GHCR pushed the new image. Coolify pulled `:latest` from its
local cache without re-checking the GHCR registry digest, so the
freshly published image never reached production until the maintainer
SSH'd into the host and forced the retag.

Longer history: `docs/audit/v1416-auto-deploy-fix.md` documents the
v1.4.15 partial fix (workflow-side webhook trigger) and why it
half-solved the problem. v1.4.22 commit `b281c06` added the explicit
`?force=true` query parameter to the webhook call so Coolify skips
its image-cache on every workflow-triggered deploy.

## Repo secrets (GitHub Settings → Secrets → Actions)

Set these once. Both required.

1. **`COOLIFY_WEBHOOK`**
   - Value: `https://<COOLIFY_INSTANCE>/api/v1/deploy?uuid=<APPLICATION_UUID>&force=false`
   - Find: Coolify UI → Application → **Webhooks** tab → "Deploy" URL.
     The workflow appends `&force=true` if your stored URL doesn't
     already carry a `force=` parameter, so either value is fine.
   - The actual values live in repo secrets only.

2. **`COOLIFY_TOKEN`**
   - Value: a Bearer token from Coolify UI → **Keys & Tokens** →
     "Create new token" → grant read + deploy scope.
   - Treat as a long-lived secret; rotate alongside any host
     credential rotation.

If either secret is missing the GitHub Actions step short-circuits
with a `::warning::` line in the workflow log — image is still
published to GHCR, but no Coolify call is made.

## Coolify UI toggle (one-time)

Open Coolify UI → Application → **Configuration** tab →
**"Watch image registry for new digests"** → **ON**.

This is the load-bearing piece. Without the toggle, `:latest` pulls
return the locally-cached digest even when the workflow webhook fires
with `force=true` — Coolify's own pull short-circuits before any
registry round-trip. Flip it once, save, never touch again.

The toggle's exact wording shifts between Coolify v4 point-releases;
look for "image registry", "digest auto-deploy", or
"auto-update" in the same tab.

## Pre-deploy data check (v1.4.23 onwards)

Migration `0036_apple_health_measurement_types` documents a unit
semantics shift for `SLEEP_DURATION` (hours → minutes) and explicitly
relies on **zero** pre-existing rows of that type. Before tagging
v1.4.23 (or any future release that re-applies migration 0036 against
a fresh database):

```
psql "$DATABASE_URL" -c "select count(*) from measurements where type = 'SLEEP_DURATION'"
```

If the count is non-zero, write a one-shot data-migration multiplying
every existing `SLEEP_DURATION` row's `value` column by 60 (hours →
minutes) BEFORE running `prisma migrate deploy`. Skipping the check
will silently shrink displayed sleep duration by 60× without
rewriting the stored numeric.

## Verification

Push a tag `vX.Y.Z` to main → wait for the GHCR build to finish →
wait ~30s →
`curl -s https://healthlog.bombeck.io/api/version | jq .data.version`
should return `X.Y.Z` automatically. If it doesn't:

1. Coolify UI → Application → **Deployments** tab → check the most
   recent deploy says "Pulled fresh image" not "Image already up to
   date". The latter means the registry-digest toggle isn't on.
2. If "already up to date" is the message, re-flip the toggle.
3. Last resort — host-side retag fallback:
   ```
   ssh apps-01
   docker pull ghcr.io/mbombeck/healthlog:vX.Y.Z
   docker tag ghcr.io/mbombeck/healthlog:vX.Y.Z ghcr.io/mbombeck/healthlog:latest
   cd /path/to/coolify/app && docker compose up -d --no-deps
   ```
   (see v1.4.21+ release summaries for the canonical command).

## Why not solve it in the workflow

Two non-options were ruled out earlier:

- **Push the explicit version tag in `docker-compose.yml`** — would
  require a workflow edit on every release. Worse than the current
  state (a one-time UI toggle).
- **Pre-deployment `docker pull` hook in the Coolify app config** —
  duplicates the registry-digest auto-deploy feature but worse: the
  pull runs on every deploy trigger (including doc-only pushes)
  instead of only when the digest changed.

The workflow file (`.github/workflows/docker-publish.yml`) already
pings Coolify's webhook with `?force=true` after the GHCR push, so
the trigger half of the contract is in place — the missing half is
the registry-digest check, which is a Coolify-side feature.
