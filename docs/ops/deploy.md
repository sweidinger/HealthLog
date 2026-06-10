# Deploy ordering

Coolify handles the standard deploy ordering automatically: the
container image is pulled, `docker-entrypoint.sh` runs
`prisma migrate deploy` against the live database, and only then does
the Next.js process bind to the listener. This page documents the
ordering explicitly for manual-rollback and partial-deploy scenarios
where the operator drives the steps by hand.

## Migration ordering

Migrations land **before** the new app container takes traffic. The
canonical command sequence on a single-instance host:

```sh
# 1. Pull the new image.
docker pull ghcr.io/mbombeck/healthlog:vX.Y.Z

# 2. Run migrations against the live DB using the new image.
docker run --rm --env-file .env.production \
  ghcr.io/mbombeck/healthlog:vX.Y.Z \
  pnpm prisma migrate deploy

# 3. Recreate the app container so it picks up the new image.
docker compose up -d app
```

The entrypoint also runs `prisma migrate deploy` on container boot, so
step 2 is redundant in normal Coolify flow. It's listed explicitly for
the manual case so an operator can verify the migration result before
flipping traffic.

### v1.11.0 notes

Migrations `0110`–`0114` are additive (new tables / columns for the
WHOOP provider hub, the longitudinal coach, and the clinician FHIR
record). They require no special steps — `prisma migrate deploy` runs
them in order on boot like any other.

WHOOP introduces two optional instance env vars, `WHOOP_REDIRECT_URI`
and `WHOOP_WEBHOOK_SECRET` (HMAC secret for WHOOP webhook signature
verification). Per-user WHOOP client id/secret live in Settings, not
in the environment. See `docs/integrations/whoop.md`. Add the two vars
to the compose `environment:` whitelist if you set them — vars not on
the whitelist never reach the container.

### What goes wrong if you reverse it

If the new app container starts before migrations run, the legacy
schema is missing the columns / indexes / enum values the new code
expects. Symptoms: Prisma client throws `P2022 column does not exist`
on the first query that touches the new shape, the request path 500s,
and the dispatcher logs fill with the same error until the migration
catches up. Health checks usually keep the container marked "healthy"
because `/api/version` doesn't exercise the affected tables — so a
naïve load balancer will happily route real traffic into the broken
shell.

### Rollback

Rolling back **migrations** is generally one-way. Prisma's migration
history table tracks applied migrations by hash; the `down` step is
not auto-generated and most HealthLog migrations are forward-only
(column drops, enum additions, index rebuilds). If a release has to
roll back:

1. Roll back the **app container** to the previous image tag.
2. Leave the **database schema** at the newer migration. The previous
   app version reads forward-compatible-ish shapes for nearly every
   release pair shipped on the v1.4.x line.
3. If a column-drop migration ships in the rollback target, hand-roll
   the column back via a fresh forward migration (`pnpm prisma migrate
dev --create-only --name vX_Y_Z_rollback_<col>`), edit the SQL,
   commit, and re-deploy. Never `migrate resolve --rolled-back` against
   production unless you've taken a fresh `pg_dump` first.

## Verify the served version

The queued-deploy status is **not** the source of truth — the version
`/api/version` actually answers is. A BuildKit layer-cache hit can
re-ship the prior image even when Coolify reports a clean deploy, so
always confirm the served build after a deploy:

```sh
# Asserts prod + demo serve 1.9.0, prints each target's buildSha,
# exits non-zero on a mismatch or timeout after a bounded retry loop.
pnpm dlx tsx scripts/assert-deploy.ts 1.9.0
```

Pass `--only=prod` / `--only=demo` to check a single target, or
`--attempts=N --interval=ms` to widen the retry window while a slow
pull settles.

## Verify the image signature

Every release image (the multi-arch manifest **index**, covering both
`amd64` and `arm64`) is signed keyless via Sigstore in the
`docker-publish.yml` merge job: GitHub's OIDC token is exchanged for a
short-lived Fulcio certificate bound to the workflow identity, and the
signature lands in the Rekor transparency log. There is no long-lived
signing key to leak or rotate.

Verify before (or after) a deploy with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/MBombeck/HealthLog/\.github/workflows/docker-publish\.yml@refs/tags/v.*' \
  ghcr.io/mbombeck/healthlog:1.16.4
```

A passing verification proves the image was built by this repository's
release workflow on a `v*` tag — not by anyone who merely obtained push
access to the GHCR package.

### Prefer digest-pinned deploys

Tags (`:latest`, `:1.16.4`) are mutable aliases: a registry-side
compromise or an accidental re-push can repoint them. The digest is the
image's only immutable identity, and it is what the signature actually
covers. For any deploy where supply-chain integrity matters more than
convenience:

1. Resolve and verify the digest once:

   ```sh
   cosign verify ... ghcr.io/mbombeck/healthlog:1.16.4 \
     | jq -r '.[0].critical.image."docker-manifest-digest"'
   ```

2. Pin the compose `image:` (or the Coolify image reference) to
   `ghcr.io/mbombeck/healthlog@sha256:<digest>` instead of the tag.

The day-to-day `:latest` + `pull_policy: always` flow stays the
documented default for self-hosters; digest pinning is the recommended
hardening for operators with a threat model that includes the registry.

## Deploy-status webhook: replay protection

`POST /api/internal/deploy-webhook` authenticates via the static
`X-Deploy-Webhook-Secret` header. Since v1.16.4 it additionally
enforces a freshness window: a request carrying an
`X-Deploy-Webhook-Timestamp` header (unix seconds, unix milliseconds,
or ISO-8601) is rejected with `401 {"status":"stale"}` when the
timestamp lies more than **5 minutes** from server time — so a captured
request cannot be replayed later to re-page admins or forge deploy
outcomes in the audit log.

Two modes:

- **Default (tolerant).** Requests _without_ the header pass — Coolify's
  stock notification sender does not attach one. A header that is
  present but stale or unparseable is always rejected.
- **Strict.** Set `DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP=true` in the app
  environment to make the header mandatory, closing the replay window
  completely. Use this when the sender (or a reverse proxy in front of
  the app) can attach the timestamp, e.g.:

  ```sh
  curl -X POST https://<host>/api/internal/deploy-webhook \
    -H "X-Deploy-Webhook-Secret: $SECRET" \
    -H "X-Deploy-Webhook-Timestamp: $(date +%s)" \
    -H "Content-Type: application/json" \
    -d '{"status":"success"}'
  ```
