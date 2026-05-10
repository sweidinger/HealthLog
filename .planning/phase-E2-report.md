# Phase E2 — v1.4.16 deploy + verify

Timestamp: 2026-05-10T03:48+02:00

## GHCR runs

Both runs `success` — Wave-C C3 fix (drop arm64 from main-branch publish,
qemu-SIGILL root cause) was effective. Main-branch GHCR no longer hangs
the way it did on v1.4.14 / v1.4.15.

| Run         | Branch    | Conclusion | Notes                                             |
| ----------- | --------- | ---------- | ------------------------------------------------- |
| 25616783583 | `v1.4.16` | success    | tag build, pushes `:1.4.16`                       |
| 25616782255 | `main`    | success    | main build, pushes `:latest` (amd64-only post-C3) |

The two runs published DIFFERENT digests, however — `:latest` resolved to
`sha256:4841bef396ad…` (main build) while `:1.4.16` resolved to
`sha256:2f1a0d6b381d…` (tag build). They diverge because they ran on
different commits / build invocations even though both are at
`d443c22`. Coolify's git-push trigger fired on the chore(release)
commit and recreated the container at `01:40:17` UTC — but at that
moment GHCR's main run was still in_progress, so Coolify pulled the
host's stale local `:latest` cache (`ace7d441f47b…`, the v1.4.15
image). Auto-deploy did NOT successfully advance to v1.4.16.

## Image digest

| Phase        | Digest                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| BEFORE       | `sha256:ace7d441f47bd8c69fd0c5e2417b7f6c53bc387aa10c9aa541ad5e6321e9581d` (v1.4.15) |
| AFTER (live) | `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa` (v1.4.16) |

Digest visibly changed. Container `app-pg8wggwogo8c4gc4ks0kk4ss-014013348914`
re-recreated at `01:45:5x` UTC after the host-side retag.

## Coolify auto-deploy: NO — retag-on-host fallback was needed

Same v1.4.14 / v1.4.15 race pattern: Coolify recreated on chore(release)
push BEFORE GHCR finished, so it pulled the stale local `:latest` cache.
Ran the documented fallback recipe:

```
ssh apps-01 'docker pull ghcr.io/mbombeck/healthlog:1.4.16 && \
  docker tag ghcr.io/mbombeck/healthlog:1.4.16 ghcr.io/mbombeck/healthlog:latest && \
  cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss && \
  docker compose up -d app'
```

## /api/version transition

- Before recreate: `1.4.15`
- After recreate: `1.4.16` — first 200 at `2026-05-10T03:45:58+02:00`
  (`01:45:58Z`), 1 s after the final retag/up command returned. Cap was
  5 min; flipped instantly.

## Production smoke (curl, 14 routes, Marc's session)

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
| `/admin/backups`          | 200    |
| `/admin/system-status`    | 200    |
| `/admin/app-logs`         | 200    |
| `/achievements`           | 200    |

\* `/dashboard` 404 is expected: HealthLog's dashboard lives at `/`
(home route, PWA convention) — there is no `/dashboard` route in the
App Router tree. `<title>HealthLog</title>` confirmed at `/`. NOT a
regression — same response shape on v1.4.15.

## GH release

URL: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16

Created via `gh release create v1.4.16 --notes-file /tmp/release-v1.4.16.md
--title "HealthLog v1.4.16" --verify-tag`. Notes extracted via
`sed -n '3,171p' CHANGELOG.md` (the awk recipe in the brief had a
precedence issue and only captured the version header line; sed
range-extract from `## [1.4.16]` (line 3) to the line before
`## [1.4.15]` (line 172) gave the full block, last line
`comparison.insightsCallout.{lastMonth,lastYear}` reserved).

## Final sanity

- `/api/version` = `1.4.16` (production, post-deploy).
- `gh release view v1.4.16` returns the release URL.
- Container healthy 4 min after recreate at write time.

## Outstanding items for v1.5

- Coolify auto-deploy race condition (Marc-side UI flip; plan in
  `docs/audit/v1416-auto-deploy-fix.md`) — still relevant; same race
  manifested on this release.
- arm64 reinstatement on `docker-publish.yml` via native
  `ubuntu-24.04-arm` matrix (currently amd64-only post-C3).
