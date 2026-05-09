# v1.4.15 marathon — state log

Status: phase-0-done
Last update: 2026-05-09T20:06:00+02:00

> Previous milestone: see `docs/audit/v1414-summary.md` (live in production at https://healthlog.bombeck.io, /api/version=1.4.14, image digest `sha256:0ced46004a54…`).

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.15
- [x] git status clean (10 leftover phase reports from v1.4.14 marathon left as untracked — they belong to the previous milestone, not this one; will not be folded into v1.4.15 commits)
- [x] codex-protocol-spec.md re-read (canonical reference for Phase C1 AI-hardening work)
- Result: ok / commit `<filled in by commit step>`
- Detailed report: `.planning/phase-0-report.md`

## Phase A — Quick fixes (5 parallel buckets)

### A1 — Nav conditionals + sidebar context-awareness

- [ ] Bug-Report-Toggle hides Sidebar nav (also bottom-nav, topbar)
- [ ] Skip-link does NOT block logo click on desktop
- [ ] Sidebar admin sub-items only expand when on `/admin/*` route (view-context-aware)
- [ ] Feedback section visible only when admin enabled feedback toggle
- Detailed report: `.planning/phase-A1-report.md`

### A2 — /admin overview redesign + /admin/api-tokens responsive

- [ ] `/admin` overview replaces section-grid with audit-log preview + system-status snapshot
- [ ] `/admin/api-tokens` table responsive (overflow-x-auto + column-hide on mobile)
- Detailed report: `.planning/phase-A2-report.md`

### A3 — Quick-add labels + Stimmung-Card mobile + onboarding flicker

- [ ] Quick-Add submenu disambiguation (no double "Hinzufügen")
- [ ] Stimmung-Card mobile: large number + label only (no doubled number/label)
- [ ] Onboarding flicker: don't render until status loaded; don't auto-open when complete
- Detailed report: `.planning/phase-A3-report.md`

### A4 — Dashboard analytics fixes

- [ ] BD-Zielbereich 0% bug — calculation review
- [ ] Medikamente graph missing in Dashboard layout
- [ ] Stimmung-chart: week/month aggregation matching other metrics
- [ ] "7-Tage-Schnitt" → "7-Tage-Trend" + trend indicator (+/-)
- [ ] Dashboard layout settings: top tiles selectable (currently only bottom rows)
- Detailed report: `.planning/phase-A4-report.md`

### A5 — Mobile UX audit + fixes

- [ ] Headless audit at Pixel 5 of `/`, `/dashboard`, `/insights`, `/admin/*`, `/settings/*`
- [ ] Fix scroll lockup on charts (touch-action / passive listeners)
- [ ] Document remaining items for v1.4.16
- Detailed report: `.planning/phase-A5-report.md`

## Phase B — Bigger features (6 parallelizable items)

### B1 — Backup completeness

- [ ] Restore from backup (server endpoint + UI)
- [ ] Download backup as JSON
- [ ] Upload backup
- [ ] Audit log of backup ops
- [ ] Docs link to "Backup structure" page on docs site
- Detailed report: `.planning/phase-B1-report.md`

### B2 — Withings + moodLog sync robustness

- [ ] Status UI in Settings → Integrations
- [ ] Refresh token rotation handling
- [ ] Telegram-notify on persistent failure (if admin enabled the channel)
- [ ] Audit-log entry on failure
- Detailed report: `.planning/phase-B2-report.md`

### B3 — Notification reliability

- [ ] Auto-disable channel on persistent 410 / hard rejects
- [ ] Retry strategy with exponential backoff
- [ ] Status visible in Settings
- Detailed report: `.planning/phase-B3-report.md`

### B4 — Achievements UI

- [ ] Surface in dashboard or dedicated page
- [ ] Unlocked-at timestamp visible
- Detailed report: `.planning/phase-B4-report.md`

### B5 — Onboarding tour first-run

- [ ] Welcome flow for new users (after passkey registration)
- [ ] Skippable
- Detailed report: `.planning/phase-B5-report.md`

### B6 — Doctor-report v2

- [ ] Configurable date range
- [ ] Practice-name on cover page
- Detailed report: `.planning/phase-B6-report.md`

## Phase C — Hardening

### C1 — AI/Codex hardening (infrastructure for hallucination-resistance)

- [ ] Provider abstraction review — multi-provider readiness
- [ ] Schema enforcement — output structured (JSON-schema), no free-form unbounded text
- [ ] Citation requirement — every claim must reference user-data point
- [ ] System-prompt scope hardening — medical-context-only, refuse out-of-scope
- [ ] Slug-drift defense — model fallback chain, dynamic discovery
- [ ] Document v1.4.16 backlog: medical-reference grounding (AHA guidelines etc.), multi-provider redundancy
- Detailed report: `.planning/phase-C1-report.md`

### C2 — Auto-deployment

- [ ] Coolify webhook on GHCR push (or watchtower equivalent)
- [ ] Failure path: admin Telegram notify (if configured) + audit log entry
- [ ] Test by tagging next release and watching auto-deploy fire
- Detailed report: `.planning/phase-C2-report.md`

### C3 — CI/e2e reliability audit

- [ ] Audit gh workflow runs: which fail / are flaky / inconsistent
- [ ] Identify root causes (not just rerun)
- [ ] Fix flaky specs
- [ ] Ensure docker-publish ALWAYS builds (v1.4.14 main hang was a clear example)
- [ ] Self-test workflow: every commit must build green for both main and tag paths
- Detailed report: `.planning/phase-C3-report.md`

### C4 — i18n coverage audit

- [ ] `admin.section.<slug>.*` fully populated EN+DE
- [ ] Other namespaces audited
- [ ] Test guards parity AND non-empty
- Detailed report: `.planning/phase-C4-report.md`

### C5 — Empty-states audit

- [ ] `/admin/users`, `/admin/backups` empty states
- [ ] Other admin sub-routes
- [ ] Dashboard empty state for very-new users
- Detailed report: `.planning/phase-C5-report.md`

## Phase D — Multi-agent QA (parallel, write-only)

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review
- [ ] senior-dev review (architecture/maintainability — separate from code-review)
- [ ] simplify on changed file set
- [ ] reconcile + apply CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-report.md`

## Phase E — Release v1.4.15

- [ ] Pre-release verify: typecheck, lint, format, test, integration, build (Node-22 CI), e2e
- [ ] Bump package.json to 1.4.15
- [ ] CHANGELOG.md entry
- [ ] Tag + push v1.4.15
- [ ] GHCR build green (BOTH main + tag — verify via the new C2 reliability work)
- [ ] Coolify auto-deploy via webhook (the C2 work tests itself)
- [ ] /api/version=1.4.15 confirmed
- [ ] Image digest changed
- [ ] Production smoke screenshots
- [ ] GH release created
- [ ] Docs site + landing-site sync
- [ ] docs.healthlog.dev: new pages "Backup structure", "User-deletion lifecycle"
- [ ] Final summary `docs/audit/v1415-summary.md` (Marc-Brief)
- Detailed report: `.planning/phase-E-report.md`

---

## Previous milestone — v1.4.14 (completed 2026-05-09T18:35+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.14` · image digest
`sha256:0ced46004a54…` (was `791c2cd2…` on v1.4.12).

Full Marc-Brief, commit table, deferred items, CI/prod state and
Codex-OAuth resolution: `docs/audit/v1414-summary.md`.

Phases run during v1.4.14 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.5/v1.4.14, git+CI sanity)
- Phase 1 — Verify Codex-OAuth flow end-to-end (`gpt-5.3-codex` slug landed in commit `5df74f7`)
- Phase 2 — v1.4.6 deferred backlog (T2.1, T2.2, T2.3, T2.5; T2.4 + T2.6 + T2.7 deferred to phase 4b)
- Phase 3 — End-to-end test coverage (41/41 specs green)
- Phase 4 — Performance audit (`/insights` −108 KiB initial JS, dashboard −950 ms checklist)
- Phase 4b — Admin Panel refactor (per-section dynamic routes, T2.6 + T2.7 folded in)
- Phase 5 — UX polish (a11y violations cleared, trend-arrow direction-as-good, saved-AI-key removal)
- Phase 6 — Multi-agent QA (code-review, security, design, simplify; CRITICAL/HIGH applied inline; HIGH+MEDIUM deferred items recorded in `.planning/v1415-backlog.md`)
- Phase 7 — Pre-release verification (typecheck/lint/format/test/integration green; build/e2e Node-25 local issue, Node-22 CI canonical)
- Phase 8 — Release v1.4.14 (rebrand patch, GHCR `:1.4.14`, host-side retag deploy, image digest `0ced46004a54…`)
- Phase 9 — Docs + landing sync (commits `06bc616` docs, `92c6588` landing)
- Phase 10 — Backfill GitHub releases v1.4.7..v1.4.13
- Phase 11 — Final summary `docs/audit/v1414-summary.md`

---

## Status block — Phase 0 (v1.4.15)

- 2026-05-09T20:06:00+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.15 marathon (phases A1-A5, B1-B6, C1-C5, D, E).
  Previous v1.4.14 entries archived above. v1.4.14 leftover phase reports
  (10 untracked files) deliberately not folded into this Phase 0 commit
  (they belong to the previous milestone). Phase 0 commit will contain
  only `.planning/STATE.md`, `.planning/ROADMAP.md`,
  `.planning/phase-0-report.md`. Marc-status: awake, watching — speed
  matters.
