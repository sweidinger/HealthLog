# v1.5 marathon — state log

Status: phase-0-done
Last update: 2026-05-09T15:25:00+02:00

> Previous milestone: see `docs/audit/v146-summary.md` (v1.4.6 marathon).
> Codex-OAuth iteration v1.4.7 → v1.4.13 landed in CHANGELOG between
> the v1.4.6 release and this marathon kickoff.

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.5
- [x] git status clean
- [x] CI status captured (v1.4.13 docker-publish still in_progress; e2e on cfa8ea6 = failure)
- [x] /api/version=1.4.13 confirmed — **DISCREPANCY**: prod still on 1.4.12 because the v1.4.13 GHCR build is mid-flight; phase-1 will need to confirm 1.4.13 lives after the build completes (force-pull recipe per hard-rule #10)
- Result: ok / commit `<filled in by commit step>`
- Detailed report: `.planning/phase-0-report.md`

## Phase 1 — Verify Codex-OAuth flow end-to-end

- [ ] /api/version=1.4.13 confirmed (currently 1.4.12 — needs force-pull after GHCR build completes)
- [ ] device-start endpoint returns spec-shaped response
- [ ] prod logs reviewed for codex.* events
- [ ] gpt-5 model accepted by chatgpt.com backend
- Detailed report: `.planning/phase-1-report.md` (will be written by phase-1 agent)

## Phase 2 — v1.4.6 deferred backlog

- [ ] T2.1 notification-channel scope of "Wipe all data"
- [ ] T2.2 Berlin TZ DST math in cross-metric joins
- [ ] T2.3 /api/insights/generate provider-error → 422/503
- [ ] T2.4 status-card-grid test brittleness
- [ ] T2.5 redactSecrets regex word-boundary
- [ ] T2.6 Backups dedicated admin section
- [ ] T2.7 /admin/users dedicated sub-route
- Detailed report: `.planning/phase-2-report.md`

## Phase 3 — End-to-end test coverage

- [ ] Authenticated dashboard render
- [ ] Add measurement flow
- [ ] Settings → KI Codex flow (mocked)
- [ ] Doctor report PDF
- [ ] Insights generation flow (mocked)
- [ ] Mobile-viewport smoke (Pixel 5, no h-scroll, CTAs ≥ 44×44)
- [ ] axe-core extended to /dashboard, /settings/integrations, /admin
- Detailed report: `.planning/phase-3-report.md`

## Phase 4 — Performance audit

- [ ] Playwright capture: /, /settings/integrations, /admin, /insights at desktop+mobile
- [ ] Report at `docs/audit/v15-performance.md`
- [ ] Top 3 wins identified, <30 LOC ones implemented inline
- Detailed report: `.planning/phase-4-report.md`

## Phase 4b — Admin Panel refactor (Settings-style dynamic routes)

- [ ] /admin/[section]/page.tsx + admin-shell sidebar
- [ ] Sections moved to /admin/<slug> routes (system-status, services, integrations, feedback, reminders, users, api-tokens, login-overview, backups, danger-zone)
- [ ] Status-card CTAs use real routes (no #anchor)
- [ ] i18n keys reorganised under admin.section.<slug>.*
- [ ] Sidebar nav expandable Admin group
- [ ] Legacy #anchor → new route redirect in proxy.ts
- [ ] Bundle-size win on /admin overview verified
- Detailed report: `.planning/phase-4b-report.md`

## Phase 5 — UX polish

- [ ] design-review walkthrough top-10 friction points
- [ ] CRITICAL/HIGH triage
- Detailed report: `.planning/phase-5-report.md`

## Phase 6 — Multi-agent QA (parallel)

- [ ] superpowers:code-reviewer
- [ ] security review
- [ ] visual / UX review
- [ ] simplify on changed file set
- Detailed report: `.planning/phase-6-report.md`

## Phase 7 — Pre-release verification

- [ ] pnpm typecheck
- [ ] pnpm lint
- [ ] pnpm format:check
- [ ] pnpm test
- [ ] pnpm test:integration
- [ ] pnpm build (Node-25 bug documented if hit)
- [ ] pnpm e2e
- Detailed report: `.planning/phase-7-report.md`

## Phase 8 — Release v1.5.0

- [ ] package.json bumped
- [ ] CHANGELOG entry
- [ ] tag v1.5.0 pushed
- [ ] GHCR build green
- [ ] Coolify deploy + force-pull
- [ ] /api/version=1.5.0 confirmed
- [ ] image digest changed
- [ ] prod smoke screenshots saved
- Detailed report: `.planning/phase-8-report.md`

## Phase 9 — Docs + landing sync

- [ ] healthlog-docs updated to v1.5
- [ ] healthlog-landing updated
- [ ] both committed + pushed
- Detailed report: `.planning/phase-9-report.md`

## Phase 10 — Backfill GitHub releases v1.4.7-v1.4.13

- [ ] Releases for v1.4.7..v1.4.13 created from CHANGELOG
- Detailed report: `.planning/phase-10-report.md`

## Phase 11 — Final summary doc

- [ ] docs/audit/v15-summary.md with Marc-Brief
- Detailed report: `.planning/phase-11-report.md`
