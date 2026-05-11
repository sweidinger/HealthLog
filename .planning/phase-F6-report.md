# Phase F6 — docs.healthlog.dev accuracy audit

Status: complete · 2026-05-10T15:42+02:00

Cross-referenced 38 `.mdx` pages under `healthlog-docs/src/content/docs/`
against the live app state (v1.4.19, image digest
`sha256:b48f93874cdb…`), CLAUDE.md, CHANGELOG.md, `.env.example`,
Dockerfile, docker-compose.yml, and `.github/workflows/docker-publish.yml`.

## Findings

| Severity | Count | Status                         |
| -------- | ----- | ------------------------------ |
| CRITICAL | 2     | fixed inline `19eb8de`         |
| HIGH     | 10    | fixed inline `3d3ea21`         |
| MED      | 9     | deferred to `v1421-backlog.md` |
| LOW      | 5     | deferred to `v1421-backlog.md` |

## Inline fixes

### `19eb8de` — env-var + arch correctness

- **S3 backup env-vars** in `configuration/environment-variables.mdx`
  and `self-hosting/scaling.mdx`: `BACKUP_S3_ACCESS_KEY_ID` →
  `BACKUP_S3_ACCESS_KEY` (matches `.env.example`), missing
  `BACKUP_RETENTION_DAYS` and `BACKUP_ENCRYPTION_KEY` added.
  Self-hosters following the docs would have got
  `MissingRequiredParameter` errors on first backup run.
- **arm64 image claim** removed from `installation.mdx` and
  `self-hosting/docker.mdx`. The workflow has been amd64-only since
  v1.4.16 (qemu SIGILL on Next.js workers); v1.5 will re-add via
  native arm64 runner.

### `3d3ea21` — production-state alignment

- Achievement count `38` → `59` plus a hidden-Easter-eggs note in
  `getting-started/introduction.mdx` and `quick-start.mdx`.
- All `Settings → Administration` pointers rewritten to `/admin/<section>`
  in `troubleshooting.mdx`, `monitoring.mdx`, `pwa-offline.mdx`,
  `mood-tracking.mdx`, `security/self-hosting.mdx` (the legacy
  Settings-shell admin tab was removed in v1.4.16 phase B6).
- `defaultLocale` default `de` → `en` in `admin-settings.mdx`
  (matches the v1.4.16 English-default flip).
- AI Insights rate-limit `2/h` → `10/h` in `api/insights.mdx` and
  `security/overview.mdx` (per v1.4.16 A7).
- AI Insights provider description replaced hard-coded `gpt-4o-mini`
  with a generic "user's configured provider chain" phrasing
  (provider-chain landed in v1.4.16 B5b).
- Mood enum locale note corrected.
- Comparison-overlay surface narrowed to `/insights` only per the
  v1.4.19 A3 relocation in `dashboard/comparison.mdx`,
  `features/dashboard-customization.mdx`,
  `features/health-metrics.mdx`.

`npm run build` green after each commit (46 pages, 0 warnings).

## Deferred (in `v1421-backlog.md` "Docs site audit" section)

9 MED items including: stale `1.2.0` docker-pull pin examples,
`architecture/database.mdx` model count drift (claims 22, schema has
26), background-jobs schedule timezone confusion (UTC vs
Europe/Berlin), missing `host-metric-sampler` and `feedback-aggregator`
job rows, "SHA-256 + HMAC" wording vs the actual keyed-HMAC-SHA-256
storage, mood-API locale note carried over from v1.2 era.

5 LOW polish items including the `/api/auth/me` example response
gravatarUrl freshness, security-overview rate-limit configurability
hints, Anthropic + Codex provider example responses on
`api/insights.mdx`, cross-link hygiene.

## Flagged for maintainer

- `api/insights.mdx`: documented as POST with session-cookie auth; the
  live route also enforces a 24h DB cache that short-circuits the
  rate limiter. F6 added a clarifying note but the `force=true` query
  parameter is not yet documented — maintainer call.
- `architecture/database.mdx` lists `User.openaiKeyEncrypted`;
  `settings/ai-providers.mdx` lists `User.aiOpenAiApiKey`. One of the
  two is the editorial / one is the actual Prisma field — F6 left
  both untouched pending verification.

## Foundation status after F6

F0–F2 + F5 + F6 + FX all complete on `develop` (HealthLog), `main`
(healthlog-docs), `main` (healthlog-landing). Ready for B1 dispatch
(Insights redesign hero strip + Daily Briefing + Suggested-prompts).
