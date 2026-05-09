# Phase C2 — Auto-deployment via Coolify webhook

**Status:** done
**Wall clock:** 2026-05-09T21:10 → 2026-05-09T21:25 Berlin (~15 min)
**Commits on `origin/main`:**

| SHA       | Message (real diff scope)                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `34c967c` | `feat(achievements): …` — sibling-agent commit message; **my** docker-publish.yml + .env.example + docs/audit/v1415-auto-deploy.md hunks rode along (5th run of the shared-cwd race documented in A2/A4/B1/B-mobile/B2/B3). |
| `ad350fe` | `feat(deploy): admin notification + audit log on deploy success/failure` — clean, my files only (`git commit -o` pathspec). |

Linked deep-dive: [`docs/audit/v1415-auto-deploy.md`](../docs/audit/v1415-auto-deploy.md).

## What changed

### 1. Auto-deploy trigger (`docker-publish.yml`)

After the `Build & push image` step, a new `Trigger Coolify deploy` step
fires `GET https://apps-01.bombeck.io/api/v1/deploy?uuid=…` with a Bearer
token. Step is `continue-on-error: true` (image is already on GHCR — a
Coolify outage must not retroactively fail the build) and skipped on PRs.
Two GitHub repository secrets gate it: `COOLIFY_WEBHOOK` (full URL) +
`COOLIFY_TOKEN` (Bearer token from Coolify UI). Missing secrets emit a
`::warning::` rather than calling Coolify with empty auth.

### 2. Status webhook handler (`src/app/api/internal/deploy-webhook/`)

`POST` accepts the free-form Coolify deploy-event payload, normalises it
defensively, writes one of `system.deploy.{success,failure,unknown}`
audit rows (with the full original payload preserved in `details.raw` for
forward-compat), and on `failure` fans a `SYSTEM_ALERT` through
`dispatchNotification()` to every admin user. `GET` is a reachability
check for Coolify's "Test" button.

Auth: timing-safe `X-Deploy-Webhook-Secret` header compare against
`process.env.DEPLOY_WEBHOOK_SECRET`. Rate-limited 60/min/IP. No new
server dependencies (Next.js native, plus existing helpers from
`api-handler`, `rate-limit`, `auth/audit`, `notifications/dispatcher`).

### 3. Documentation

- `docs/audit/v1415-auto-deploy.md` — investigation, decision log
  (Coolify webhook over Watchtower), failure modes, **Marc-side
  follow-up steps**.
- `.env.example` — new `DEPLOY_WEBHOOK_SECRET` block with link to
  the audit doc.

## Verification

- `pnpm test` — **952 / 952 pass** (was 940 at C2 start; +12 new tests
  for the deploy-webhook handler).
- `pnpm typecheck` — pre-existing `dashboard-layout.test.ts` (A4 lane)
  and `doctor-report-pdf-core.test.ts` (B6 lane) errors only; nothing new
  in C2 scope.
- `pnpm lint` — no new errors in C2 files; pre-existing `doctor-report-dialog.tsx`
  set-state-in-effect error untouched (B6 owns).
- Workflow YAML parses (`ruby -ryaml -e "YAML.load_file('.github/workflows/docker-publish.yml')"` — `yaml ok`).

## Marc-side follow-up (4 manual steps)

The code is fully shipped, but auto-deploy doesn't fire until Marc
populates the secrets. None of these are agent-doable.

1. **Generate a Coolify API token** in `https://apps-01.bombeck.io/`
   → Keys & Tokens → "Create New Token", permission `*`. Copy once,
   it's not redisplayed.
2. **Add 2 GitHub repository secrets** (Settings → Secrets → Actions):
   - `COOLIFY_WEBHOOK = https://apps-01.bombeck.io/api/v1/deploy?uuid=pg8wggwogo8c4gc4ks0kk4ss&force=false`
   - `COOLIFY_TOKEN  = <token from step 1>`
3. **Generate `DEPLOY_WEBHOOK_SECRET`** with `openssl rand -hex 32`,
   then add it to:
   - HealthLog container env on `apps-01` (Coolify UI → app → Environment Variables → `DEPLOY_WEBHOOK_SECRET`).
   - Coolify outgoing webhook config (Settings → Notifications → Webhook):
     - URL: `https://healthlog.bombeck.io/api/internal/deploy-webhook`
     - Custom header: `X-Deploy-Webhook-Secret: <value>`
     - Enable: deployment success + deployment failure
4. **Test** with a no-op commit on `main`. Expected behaviour:
   - GHCR build runs and pushes `:latest`.
   - GH Actions step "Trigger Coolify deploy" prints HTTP 200 with the
     Coolify deploy job UUID.
   - `apps-01` recreates the app container.
   - Coolify pings `/api/internal/deploy-webhook`; AuditLog row
     `system.deploy.success` appears in `/admin/audit-log`.
   - `/api/version` reflects new build (or unchanged if no-op).

## Race-condition note (operational)

This is the **6th** consecutive phase to surface the shared-cwd staging
race. Commit-1 of C2 was absorbed into a sibling agent's
`feat(achievements)` commit message because their `git add -A` ran
between my `git add` and `git commit`. Recovered for commit-2 by using
`git commit -o <pathspec>` which pre-stages exactly the listed paths
inside the same atomic syscall — no window for a sibling's index
change to leak in. Same recommendation as A2 / A4 / B1 / B-mobile /
B2 / B3: **v1.4.16 should mandate `superpowers:using-git-worktrees`
per parallel agent.**

## Deferred — not in C2 scope

- **Watchtower fallback** (Path B in the audit doc) — only if the
  Coolify webhook proves unreliable across multiple v1.4.X releases.
  Adding a polling daemon to the trusted compute base of `apps-01` is
  not free.
- **Slack/Discord deploy channels** — pluggable through the same
  `dispatchNotification` channel-abstraction; B3 already wired
  notification reliability so adding a non-Telegram channel for
  ops is a separate v1.4.16 ticket.
- **Bidirectional sync to GitHub Deployments API** — would require a
  GitHub App token, separate scope.
