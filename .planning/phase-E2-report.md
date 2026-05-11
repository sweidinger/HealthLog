# Phase E2 — v1.4.18 deploy + verify

Timestamp: 2026-05-10T11:30+02:00 (approx; deploy completed during this
session right after GHCR finished)

## GHCR runs

Both runs `success`. Wave-C v1.4.16 fix (drop arm64 from main publish,
qemu-SIGILL root cause) continues to hold — neither the tag nor the main
build hung this release.

| Run         | Branch    | Conclusion | Notes                                                         |
| ----------- | --------- | ---------- | ------------------------------------------------------------- |
| 25624945158 | `v1.4.18` | success    | tag build, pushes `:1.4.18`                                   |
| 25624944843 | `main`    | success    | main build, pushes `:latest` (amd64-only post-Wave-C v1.4.16) |

Both runs target the same head SHA `0243e208` (chore(release) commit on
both `main` and the `v1.4.18` tag).

## Image digest transition

| Phase        | Digest                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| BEFORE       | `sha256:936e9cf25b2d8e75d70a7912a42c8b0647e374ece036eb451676d0be9cd120ce` (v1.4.17) |
| AFTER (live) | `sha256:c636fca7db66479b3413a7df82117316c042641f9bc7c0fe7d6e2be6811dfcca` (v1.4.18) |

Digest visibly changed; container `app-pg8wggwogo8c4gc4ks0kk4ss-091446035222`
recreated cleanly with db dependency wait → healthy → started.

## Coolify auto-deploy: deferred (still git-push trigger)

Same pattern as v1.4.16 / v1.4.17 — Coolify is wired to fire on the
chore(release) push, which races GHCR. Marc's brief explicitly noted
"Coolify still on git-push trigger (deferred fix)", so phase-E2 ran the
documented force-pull path:

```
ssh apps-01 'cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss && \
  docker compose pull app && docker compose up -d app'
```

The `:latest` tag had already been refreshed by the main-branch GHCR run
(both runs succeeded before the pull), so the simple `docker compose pull`
path sufficed; the `:1.4.18`-retag fallback was NOT needed.

## /api/version transition

- Before recreate: `1.4.17`
- After recreate: `1.4.18` — flipped within the first 5-second poll
  cycle of the wait loop (well under the 5-min cap).

## Production smoke (curl, 15 routes, Marc's session)

| Path                      | Status |
| ------------------------- | ------ |
| `/`                       | 200    |
| `/dashboard`              | 404 \* |
| `/insights`               | 200    |
| `/auth/login`             | 200    |
| `/settings/integrations`  | 200    |
| `/settings/notifications` | 200    |
| `/settings/ai`            | 200    |
| `/settings/export`        | 200    |
| `/admin`                  | 200    |
| `/admin/users`            | 200    |
| `/admin/api-tokens`       | 200    |
| `/admin/backups`          | 200    |
| `/admin/system-status`    | 200    |
| `/admin/app-logs`         | 200    |
| `/achievements`           | 200    |

\* `/dashboard` 404 is expected (carry-over from v1.4.16/v1.4.17 phase-E2
reports): HealthLog's dashboard lives at `/`. There is no `/dashboard`
route in the App Router tree (`src/app/page.tsx` is the dashboard;
`src/app/dashboard/` does not exist). Same response shape on v1.4.17
pre-deploy; not a regression. All 14 real paths return 200, including
the changed surfaces this release touched (`/insights`,
`/settings/{integrations,notifications,ai,export}`, `/admin/*`,
`/achievements`).

## GH release

URL: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.18

Created via `gh release create v1.4.18 --notes-file /tmp/release-v1.4.18.md
--title "HealthLog v1.4.18" --verify-tag`. The awk recipe in the brief
again captured only the version-header line (same precedence issue as
v1.4.16); fell back to `sed -n '3,74p' CHANGELOG.md` which spans from
`## [1.4.18]` (line 3) to the line before `## [1.4.17]` (line 75) — 72
lines of release notes attached to the GitHub release.

## Final sanity

- `/api/version` = `1.4.18` (production, post-deploy).
- `gh release view v1.4.18` returns the tag/title/URL triplet
  (`v1.4.18 — HealthLog v1.4.18 — https://github.com/MBombeck/HealthLog/releases/tag/v1.4.18`).
- `db-pg8wggwogo8c4gc4ks0kk4ss` waited healthy, app container started
  cleanly; no rollback action taken (and per brief constraints, would
  not have been taken even on red).

## Outstanding items for v1.5

- Coolify auto-deploy git-push race condition — still pending the
  Marc-side UI flip from "git-push trigger" to "registry/webhook
  trigger" (plan: `docs/audit/v1416-auto-deploy-fix.md`).
- arm64 reinstatement on `docker-publish.yml` via native
  `ubuntu-24.04-arm` matrix (currently amd64-only post Wave-C v1.4.16).
