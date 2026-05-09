# v1.4.15 — Auto-deployment audit & design

**Phase:** C2
**Last updated:** 2026-05-09 (v1.4.15 marathon)
**Status:** designed + shipped — see commits in `.planning/phase-C2-report.md`.

## Background

Through v1.4.6 → v1.4.14 the recipe to deploy a freshly-published GHCR image
to production has been:

1. Tag a release → GHCR builds and pushes the image (`docker-publish.yml`).
2. Trigger Coolify "Deploy" via the dashboard.
3. **Manually SSH** to `apps-01` and force-pull the image because Coolify's
   own deploy did not always honour the new digest:

   ```bash
   ssh apps-01 'docker pull ghcr.io/mbombeck/healthlog:1.4.X && \
     docker tag ghcr.io/mbombeck/healthlog:1.4.X ghcr.io/mbombeck/healthlog:latest && \
     cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss && \
     docker compose up -d app'
   ```

4. Verify `/api/version` returned the new version + image digest changed.

Marc's request for v1.4.15 — **eliminate step 2 and 3**. When GHCR has a new
image, the production container should redeploy by itself.

## Investigation — what Coolify supports

Coolify version on `apps-01.bombeck.io`: **`4.0.0-beta.470`** (verified via
`mcp__coolify-apps01__get_version`).

The current application config (UUID `pg8wggwogo8c4gc4ks0kk4ss`,
`/api/v1/applications/pg8wggwogo8c4gc4ks0kk4ss`) shows:

- `build_pack: dockercompose`
- `git_repository: MBombeck/HealthLog`, `git_branch: main`
- `source_type: App\Models\GithubApp` — this matters: Coolify's "auto-deploy
  on git push" is wired to the GitHub App webhook, **not** to the GHCR
  package webhook. There is no native "redeploy when registry has new image"
  mode for `dockercompose`-typed apps.
- `manual_webhook_secret_github: null` — no webhook secret configured today.

What Coolify *does* support natively (per the Coolify docs):

1. **GitHub App auto-deploy**: pushes to `main` trigger an immediate redeploy.
   For us this would deploy from a SHA *before* GHCR finishes building, since
   GHCR runs in the same push event in parallel. Race-prone.
2. **Deploy webhook URL**: every Coolify resource exposes
   `GET https://<coolify-fqdn>/api/v1/deploy?uuid=<resource-uuid>` with
   Bearer-token auth. This is a *trigger-only* surface — it queues a
   redeploy. Coolify treats this as an authenticated remote-control command;
   the recipe in the docs is "GitHub Actions builds the image, pushes to
   GHCR, then `curl --request GET '${{ secrets.COOLIFY_WEBHOOK }}'
   --header 'Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}'`."
3. **Notification webhook (outgoing)**: Coolify can POST a deployment-event
   payload to a configured URL on success and failure. This is how we get a
   notification back into the app for audit logging + admin alerts.

`(2)` solves the "trigger" half; `(3)` solves the "report" half. We use both.

## Decision — chosen approach

**Path A (chosen):** GitHub Actions → Coolify deploy webhook → Coolify
notifications → HealthLog `POST /api/internal/deploy-webhook`.

Rationale:

- Native to Coolify; no extra daemon on `apps-01`.
- Both halves of the auto-deploy contract (trigger + status) live in
  configuration we already control.
- Watchtower would mean shipping a new container, an extra footprint to
  audit, and (since v1.4.14 has multi-tenant prep with worker-mode
  separation) a polling daemon that might wake the app off-pattern. The
  Coolify webhook is event-driven and free.

**Path B (rejected — but kept on the table for v1.4.16 if Coolify webhook
proves unreliable):** Watchtower with a per-image label
(`com.centurylinklabs.watchtower.enable=true`) gated on `ghcr.io/mbombeck/healthlog`.

## Implementation plan (3 atomic commits)

1. **`feat(deploy): auto-deploy on GHCR push (no more manual force-pull)`**
   - `.github/workflows/docker-publish.yml`: after the `Build & push image`
     step, add a final `Trigger Coolify deploy` step that runs only on the
     publish path (push to `main` or to a `v*` tag — never on PRs). It uses
     `secrets.COOLIFY_WEBHOOK` (the full Bearer-protected URL with `?uuid=…`)
     + `secrets.COOLIFY_TOKEN`. Failure of the deploy trigger does **not**
     fail the build (the image is already published; deploy is a follow-up).
   - Document required secrets in `.env.example`.

2. **`feat(deploy): admin notification + audit log on deploy success/failure`**
   - New endpoint: `src/app/api/internal/deploy-webhook/route.ts` that
     accepts a Coolify-format JSON payload and:
     - validates `X-Deploy-Webhook-Secret` header (timing-safe) against
       `process.env.DEPLOY_WEBHOOK_SECRET`;
     - rate-limits by client IP;
     - writes an `auditLog` row with `system.deploy.{success,failure}`;
     - on failure, calls `dispatchNotification({ eventType: "SYSTEM_ALERT" })`
       for every admin user (so Telegram is paged if configured) — same
       pattern as `src/lib/integrations/status.ts:maybeAlertAdmins`.
   - Webhook handler is a Next.js Route Handler — no new deps.
   - Unit-tested with the same mock pattern as
     `src/app/api/withings/webhook/__tests__/route.test.ts`.

3. **Document everything** in this file + `phase-C2-report.md`.

## Marc-side configuration after merge

Since the agent does not have access to Marc's GitHub repo settings or
Coolify's UI directly, three manual steps remain after the auto-deploy code
ships:

1. **Generate a Coolify API token** in Coolify UI → `Keys & Tokens` →
   "Create New Token" with permission `*` (or `read:sensitive` plus deploy).
   Token format: `n_<base62>`.
2. **Add two GitHub repository secrets**:
   - `COOLIFY_WEBHOOK` =
     `https://apps-01.bombeck.io/api/v1/deploy?uuid=pg8wggwogo8c4gc4ks0kk4ss&force=false`
   - `COOLIFY_TOKEN` = the token from step 1.
3. **Configure Coolify outgoing notifications**:
   - Settings → Notifications → Webhook
   - URL: `https://healthlog.bombeck.io/api/internal/deploy-webhook`
   - Add custom header: `X-Deploy-Webhook-Secret: <DEPLOY_WEBHOOK_SECRET>`
     (the value placed into `apps-01:.env` for the HealthLog container)
   - Enable: deployment success + deployment failure
4. **Set `DEPLOY_WEBHOOK_SECRET` env var** on `apps-01` (HealthLog
   container `.env` + Coolify environment variables UI). Generate with
   `openssl rand -hex 32`.

These four manual steps are tracked in `.planning/phase-C2-report.md`'s
"Marc-side follow-up" section. The code is fully complete and tested without
them; auto-deploy simply doesn't fire until the secrets are populated.

## Failure modes considered

| Failure                                       | What happens                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Coolify deploy URL down                       | GH Actions step continues (`continue-on-error: true`); image stays on GHCR, Marc deploys manually.  |
| Coolify notification fires before image pull  | Coolify retries the pull internally; final status (success/failure) reaches our webhook regardless. |
| Webhook secret leaked                         | Rotate `DEPLOY_WEBHOOK_SECRET`, redeploy. Audit-log entry on every received call shows source IP.   |
| Webhook handler down at deploy time           | Coolify retries 3× per docs; final missed event is recoverable from Coolify's own deployment log.   |
| Coolify API rejects token (permission scope)  | GH Actions step prints the response body; agent's next merge surfaces it as a workflow failure.     |
| GHCR push succeeds but webhook step is broken | Image still gets to GHCR; manual deploy still works as a fallback.                                  |

## Watchtower — why not (revisited)

If Path A breaks (Coolify webhook flaky, beta channel regression, …),
v1.4.16 can install Watchtower:

```yaml
# /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss/docker-compose.yaml
# (additional services block, NOT in the main compose)
services:
  watchtower:
    image: containrrr/watchtower:1.7.1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command:
      - --interval=300
      - --label-enable
    restart: unless-stopped
```

with the existing app service labelled
`com.centurylinklabs.watchtower.enable=true`. We deliberately do not ship
this in v1.4.15 — adding a polling daemon to the production host is a
material expansion of the trusted compute base and the Coolify path is
good enough.

## References

- Coolify GitHub Actions guide:
  <https://coolify.io/docs/applications/ci-cd/github/actions>
- Coolify Authorization API docs:
  <https://coolify.io/docs/api-reference/authorization>
- v1.4.14 manual force-pull recipe: `.planning/phase-8-report.md`
- C3 docker-publish reliability fix: `docs/audit/v1415-ci-reliability.md`
