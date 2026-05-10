# v1.4.21 backlog

Carry-over from v1.4.20 marathon foundation phases. Pick from this list
when v1.4.21 starts.

## F5 — Best-practice repo audit (deferred MED + LOW)

- **README badges** (LOW). Add a small badge row: build status (GitHub
  Actions), license (AGPL-3.0), latest GHCR tag, container size,
  package-version. Today the README is content-rich but visually
  unanchored. Pure cosmetic.
- **FUNDING.yml** (optional). Skipped because no GitHub Sponsors / Ko-fi /
  OpenCollective profile is configured. Add when the maintainer enables
  one.
- **Repo-root tidy** (LOW). The root currently carries `coverage/`,
  `playwright-report/`, `test-results/` directories which are listed in
  `.gitignore` but render as empty entries during `ls -la`. No action
  needed unless a future audit re-flags.
- **`.gitignore` audit** (LOW). Inherits Next.js + standard Node patterns.
  Spot-check did not surface gaps.
- **Discussions enablement** (LOW). The new `.github/ISSUE_TEMPLATE/config.yml`
  links to `https://github.com/MBombeck/HealthLog/discussions`; verify
  that Discussions is actually enabled on the repository before v1.4.21
  ships, or remove the link.

## FX (cleanup) carry-over

- **Source-comment sweep** (LOW). `src/` has 191 `Marc` references in
  maintainer-internal source comments. Visible to anyone who clones the
  repo. Lower priority than user-rendered surfaces; schedule for a
  hygiene PR.
- **DE+EN bilingual CHANGELOG entries** (MED). v1.4.15-era entries pair
  a German sentence with its English translation by historical design.
  English-only normalisation is a larger rewrite — defer.
- **`CLAUDE.md` + `AGENTS.md` filenames** (MED). Visible at repo root.
  These document AI-agent conventions; renaming is a structural change
  with downstream link impact. Defer until a hygiene PR.

## v1.4.19 backlog passthrough (from `v1420-backlog.md`)

The v1.4.19 quality-of-life audit deferred 31 MED + 16 LOW + 4 HIGH +
4 reconcile-HIGH items into `.planning/v1420-backlog.md`. v1.4.20 picks
selectively (the redesign owns its own scope); the rest moves here on
v1.4.21 kickoff. See that file for the full list.

## Docs site audit (v1.4.19 cross-reference, deferred MED + LOW)

Audit walked all 38 pages under `healthlog-docs/src/content/docs/**`
against the live app (v1.4.19, image digest `sha256:b48f93874cdb…`),
the CHANGELOG, `.env.example`, `Dockerfile`, `docker-compose.yml`, and
`.github/workflows/docker-publish.yml`. CRITICAL + HIGH already landed
on `healthlog-docs/main` (commits `19eb8de`, `3d3ea21`). Items below
are MED + LOW and were deliberately left for a hygiene pass.

### MED — stale or imprecise but not load-bearing

- **Stale version pins in installation / docker / admin examples.**
  `getting-started/installation.mdx` and `self-hosting/docker.mdx` show
  `:1.2.0` as the pin example; `api/admin.mdx` returns `"version":
  "1.2.1"` in its sample response. Bump all three to a current `1.4.x`
  reference on the next docs sweep.
- **`architecture/database.mdx` model count + measurement-type list.**
  Page claims **22 models**; current schema has **26**. Measurement
  table also stops at the v1.2 catalogue (WEIGHT / BP_SYS / BP_DIA /
  PULSE / BODY_FAT / SLEEP_DURATION / ACTIVITY_STEPS) — needs the v1.3
  additions (BLOOD_GLUCOSE, OXYGEN_SATURATION, TOTAL_BODY_WATER,
  BONE_MASS) so the API page and the architecture page agree.
- **`architecture/background-jobs.mdx` schedule timezone.** Lists
  `Sunday 03:00 UTC` and `02:00–02:30 UTC` for the data-backup and
  insights queues. Actual schedule is **Europe/Berlin** (CLAUDE.md +
  `admin/backups.mdx` already document it correctly). Same drift in
  `features/export-import.mdx` (`Schedule: Sunday 03:00 UTC` block on
  line 96) — keep both in sync.
- **`architecture/background-jobs.mdx` job catalogue is incomplete.**
  Missing `host-metric-sampler` (v1.4.16, host CPU/mem/IO every minute)
  and `feedback-aggregator` (v1.4.16, daily 04:00 Europe/Berlin AI
  feedback rollup). Add rows for both.
- **API token hashing wording.** `architecture/overview.mdx` and
  `security/overview.mdx` describe the token store as "SHA-256 + HMAC"
  / "stored as SHA-256 + HMAC hashes". The actual algorithm is **keyed
  HMAC-SHA-256** (`API_TOKEN_HMAC_KEY` in `.env.example`,
  `src/lib/auth/hmac.ts`). The other API/integrations/external-ingest
  pages already use the correct phrasing — bring these two into line.
- **`api/insights.mdx` provider claim.** Now generic ("user's
  configured provider chain") after the v1.4.19 docs fix; the per-
  provider request/response examples could still be tightened to show
  Anthropic / Codex shapes alongside the OpenAI one. Cosmetic.
- **`api/mood.mdx` "primary UI language is German" note.** Wording
  carried over from the v1.2 era. Already corrected in
  `features/mood-tracking.mdx`; mirror the same locale-neutral
  phrasing in the API page.
- **Architecture overview i18n line** (`overview.mdx` line 105). Lists
  "Supported languages: German and English" without flagging that
  English is the codebase default. Tighten to match CLAUDE.md.
- **`features/export-import.mdx` Sunday-03:00-UTC block.** See above —
  same Berlin/UTC drift; the surrounding paragraph already hints at
  pg-boss without naming the timezone explicitly.

### LOW — wording and polish

- **`api/overview.mdx` example response includes `email` field.** The
  `/api/auth/me` route returns `gravatarUrl` and the user shape; the
  example could be refreshed to include the gravatar URL pattern that
  the `/auth/me` handler now ships.
- **`getting-started/installation.mdx` "Pin a specific version".**
  After the version-bump pass (see MED above), tighten the surrounding
  paragraph to mention SLSA + SBOM verification commands once instead
  of twice.
- **`security/overview.mdx` rate-limit table polish.** Now shows
  `10 req/h (configurable …)` for AI insights — apply the same
  configurability hint to the data-ingest row and the bug-report row
  for consistency, if either is configurable.
- **`api/insights.mdx` provider example responses.** Add a short
  Anthropic and Codex sample alongside the existing OpenAI shape so
  client implementers know what to expect. Pure DX polish.
- **Cross-link hygiene.** A handful of pages still link to
  `/settings/admin` or `/settings/administration` style anchors that
  were rewritten — search the tree for any remaining instances after
  the next set of edits.

Total deferred from this audit: **9 MED + 5 LOW**. CRITICAL + HIGH
fixed inline at `healthlog-docs` commits `19eb8de` and `3d3ea21`.
