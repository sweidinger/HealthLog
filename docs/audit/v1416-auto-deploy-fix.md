# v1.4.16 — Auto-deploy follow-up (image-digest only)

**Phase:** Wave-C / item 4
**Last updated:** 2026-05-09 (v1.4.16 marathon)
**Status:** designed, not shipped — DEFERRED to v1.5 (Marc-side manual step
required; MCP API does not expose the toggle)

## Background — what v1.4.15 left half-finished

The v1.4.15 C2 work (`docs/audit/v1415-auto-deploy.md`) wired the
publish workflow to call Coolify's deploy webhook AFTER GHCR pushes the
new image. That solves the "deploy fires when there is a new image" half
correctly.

What it did NOT solve: the Coolify application is configured with the
GitHub-App integration (`source_type: App\Models\GithubApp`,
`git_repository: MBombeck/HealthLog`, `git_branch: main`). Coolify's
GitHub App auto-deploy fires on EVERY push to `main` — including
`.planning/`, `docs/`, `CHANGELOG.md`, `README.md` and other doc-only
commits that change zero image bytes. The compose pulls
`ghcr.io/mbombeck/healthlog:latest`, finds the same digest, but still
recreates the containers (Coolify always restarts the stack on a deploy
event). During the v1.4.15 marathon Marc reported visible container
churn — multi-second downtime windows on every doc-only push.

We need: deploy fires only when the image digest actually changes.

## Investigation — what Coolify v4 supports

Coolify v4.0.0-beta.470 (current production) exposes these
deploy-trigger toggles on a `dockercompose` application:

| Setting          | Effect                                                            | API access          |
| ---------------- | ----------------------------------------------------------------- | ------------------- |
| Auto Deploy      | GitHub-App webhook listens to push events                         | UI only (no MCP / REST endpoint exposes it on v4-beta) |
| Watch Paths      | Glob list — push-event paths must match for auto-deploy to fire   | UI only             |
| Deploy Webhook   | Bearer-protected `GET /api/v1/deploy?uuid=…` — programmatic trigger | MCP-callable      |
| Notification Webhook | Outgoing POST when deploy completes (success / failure)       | UI only             |

The MCP `application.update` action exposed by `coolify-apps01`
intentionally restricts mutations to the safe subset
(`fqdn`, `health_check_*`, `domains`, `name`, `description`,
`environment_*`, `instant_deploy`, build-pack family). It does NOT
expose `auto_deploy_enabled` or `watch_paths`. Calling the bare REST
API would require a Coolify UI-issued token AND would bypass the
guardrails the MCP wraps around the install — too far outside agent
scope.

The Coolify community has an open feature request to expose
`auto_deploy_enabled` over REST; the v4-stable line (expected July
2026) is the realistic landing window.

## Watchtower — re-examined

`v1415-auto-deploy.md` rejected Watchtower for v1.4.15 ("polling daemon
is material TCB expansion"). Re-examined here:

- The `dockercompose` build_pack on Coolify v4 ships a `restart: unless-stopped`
  policy already; adding a Watchtower sidecar with `--label-enable` and
  a per-image `com.centurylinklabs.watchtower.enable=true` label on
  the `app` service would re-pull on registry-digest change with NO
  push-event traffic.
- **But** a Watchtower install on `apps-01` would also need
  read access to GHCR (private images) and sit in the same docker
  network as every other app on the host. That's a larger blast radius
  than the surgical "flip one Coolify toggle" alternative below.

## Chosen approach — DEFER to v1.5 with concrete plan

**v1.5 plan** (concrete, two-step):

### Step 1 — Marc-side manual toggle (5 min, before v1.5 cut)

Open Coolify UI →
`Applications > m-bombeck/-health-log:main-pg8wggwogo8c4gc4ks0kk4ss > Configuration`:

1. **General → Auto Deploy:** turn OFF.
2. (Optional) **General → Watch Paths:** leave empty — the toggle
   above is enough; `watch_paths` only matters with Auto Deploy ON.
3. **Save.**

Effect: GitHub-App push events from `main` no longer fire a Coolify
deploy. The Actions-driven `Trigger Coolify deploy` step in
`docker-publish.yml` (already shipped in v1.4.15) becomes the SOLE
trigger — and it only fires AFTER the image actually pushes to GHCR.
Doc-only commits never reach the deploy queue.

### Step 2 — automate the toggle for v1.5+

When Coolify v4-stable lands (or once `coolify-apps01` MCP gains the
`auto_deploy_enabled` field), patch
`scripts/configure-coolify-app.ts` to flip the toggle programmatically.
Until then the manual UI step is the contract.

### Why NOT Watchtower for v1.4.16

Marc's instruction was explicit: "Don't half-ship". Watchtower would
ship code (a new container in the prod compose, new credentials to
manage) for a problem the manual Coolify toggle solves with zero new
moving parts. The right call is the toggle.

## Test plan after Marc flips the toggle

1. Push a doc-only commit to `main` (e.g. amend `CHANGELOG.md`
   wording).
2. Watch Coolify's deployment history for `pg8wggwogo8c4gc4ks0kk4ss`
   — there should be NO deploy entry for that SHA.
3. Watch GHCR — no new image should be published either (the
   `docker-publish.yml` workflow only runs `pnpm exec docker buildx`
   when source changes, but we haven't path-filtered it yet — that's
   a separate v1.5 task).
4. Tag a real release (e.g. `v1.5.0`) — the workflow runs, GHCR
   publishes, and the `Trigger Coolify deploy` step fires the
   webhook. Coolify deploys ONCE.

## Status after this audit

- v1.4.16: NO source change shipped for this item. The audit document
  is the deliverable.
- Marc-side action: flip the Coolify toggle whenever convenient. Does
  not block v1.4.16 release.
- v1.5 backlog: track the MCP-API automation as a concrete follow-up.
