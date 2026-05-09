# v1.4.16 marathon — state log

Status: phase-0-done
Last update: 2026-05-09T23:12:52+02:00

> Previous milestone: `docs/audit/v1415-summary.md` (live: `/api/version=1.4.15`,
> image digest `sha256:ace7d441f47b…`).

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.16
- [x] git status clean
- [x] codex-protocol-spec re-read
- [x] v1416-backlog.md inventoried
- Result: ok / commit `chore(planning): bootstrap v1.4.16 marathon` on origin/main
- Detailed report: `.planning/phase-0-report.md`

## Wave A — Quick fixes (parallel buckets)

### A1 — Sidebar admin-expand bug

- [ ] Clicking Admin from non-admin route does NOT auto-expand sub-items (mirror Settings exact pattern)
- [ ] Gravatar dropdown does NOT trigger sidebar expansion side-effect
- Detailed report: `.planning/phase-A1-report.md`

### A2 — BD-Zielbereich real-fix (regression from v1.4.15 A4)

- [ ] Investigate root cause — A4 in v1.4.15 marked this fixed but Marc still sees 0%
- [ ] Verify against actual user data with measurements
- [ ] Fix root cause + add E2E test that exercises full flow against real session
- Detailed report: `.planning/phase-A2-report.md`

### A3 — /admin/api-tokens table responsive (still scrolling)

- [ ] Inspect current state on prod with Marc's session — overflow-x scrollbar visible
- [ ] Fix properly: card-list mobile fallback OR proper column-hide chain at xs/sm/md breakpoints
- Detailed report: `.planning/phase-A3-report.md`

### A4 — "7-Tage-Schnitt" → "7-Tage-Trend" DE + indicator on ALL charts

- [ ] DE i18n string rename everywhere (incl. tile-strip + chart subtitles)
- [ ] Trend indicator (+/-) appears for EVERY chart including mood + medication + insights
- [ ] Trend on "all" filter computes correctly (currently shows 0)
- Detailed report: `.planning/phase-A4-report.md`

### A5 — Top-tile-selector real-fix (regression from v1.4.15 A4)

- [ ] Investigate why settings save isn't reflected on dashboard
- [ ] Probably a query-cache stale-read OR the layout-config field isn't actually consumed by the tile-strip
- [ ] Fix + e2e test toggling visibility persists
- Detailed report: `.planning/phase-A5-report.md`

### A6 — Medication-chart 7d-trend + target-range

- [ ] Medication-chart matches other charts: 7d-trend label + indicator + target-range visualization
- Detailed report: `.planning/phase-A6-report.md`

### A7 — AI Generator rate-limit 10/h + cache-invalidate-on-new

- [ ] Rate-limit current 2/h → 10/h (env-configurable)
- [ ] When user generates new insight: evict ALL cached previous insights for that user (TanStack Query invalidate + DB-cached row replacement)
- [ ] Verify: dashboard shows newest insight, never stale-cached
- Detailed report: `.planning/phase-A7-report.md`

### A8 — Umlaute encoding bug + login-overview

- [ ] "Nrnberg" should be "Nürnberg" — find the encoding step that strips umlauts
- [ ] Audit all transformer / geocoder / external-api decode steps for UTF-8 correctness
- [ ] Regression test for known-umlaut roundtrip
- Detailed report: `.planning/phase-A8-report.md`

## Wave B — Quality-leap features

### B1 — Insights/Charts Apple-Health-style visual leap

- [ ] Benchmark against Apple Health, Withings Health Mate, Oura Ring
- [ ] Insights surface: gradient fills, animation, dynamic comparisons (better/worse), interactive tooltips, vertical slide-to-compare
- [ ] Charts: same level of polish — Recharts replacement allowed if quality bar requires
- [ ] Insights surface visualizes data, not just text-summarizes
- Detailed report: `.planning/phase-B1-report.md`

### B2 — AI provider settings UX cleanup (Pulldown-driven)

- [ ] Settings → AI: provider dropdown drives form below (no top/bottom split)
- [ ] All providers configurable from one UI (OpenAI direct + ChatGPT-account + future)
- [ ] Smooth transition when provider changes
- Detailed report: `.planning/phase-B2-report.md`

### B3 — Admin System-Status host-load chart

- [ ] Host CPU/memory/disk-io graph last 2h (use existing Sentinel or pull from Coolify metrics)
- [ ] Render above current system-status section
- Detailed report: `.planning/phase-B3-report.md`

### B4 — Admin logs visibility deepening

- [ ] Audit log: filterable by actor/action/target/severity, paginated, exportable
- [ ] App-log preview: tail of structured wide-events for last 1h, filterable by trace_id
- Detailed report: `.planning/phase-B4-report.md`

### B5 — AI hallucination-hardening v2 (medical grounding + multi-provider)

- [ ] Medical-reference grounding: AHA/ESH/WHO target-range citations in system context
- [ ] Multi-provider redundancy: try-each-on-hard-failure
- [ ] Per-recommendation explainability + confidence score
- [ ] User-feedback loop ("was this helpful?" → prompt-tuning over time)
- Detailed report: `.planning/phase-B5-report.md`

### B6 — Settings naming-audit

- [ ] Every settings sub-route reviewed for stringency, naming consistency, logical grouping
- [ ] No top/bottom split anti-pattern anywhere
- [ ] No double naming
- Detailed report: `.planning/phase-B6-report.md`

### B7 — Settings → Export menu (Arztbrief consolidated)

- [ ] New /settings/export route with consolidated UI: Doctor-report (PDF, configurable date range + practice name from B6 v1.4.15) + CSV/JSON exports (measurements/medications/mood per CLAUDE.md src/lib/export.ts)
- [ ] Properly designed: card per export type, clear preview + filter + download button
- [ ] Rename current doctor-report entry-point to live under /settings/export
- Detailed report: `.planning/phase-B7-report.md`

## Wave C — Catch-up (deferred from v1.4.15)

- [ ] 8 deferred HIGH-Findings from v1.4.15 Wave-D (see `v1416-backlog.md`)
- [ ] 5 deferred MED items from A5 mobile findings
- [ ] Coolify image-digest auto-deploy trigger (replace git-push trigger so deploys only happen on actual new image)
- [ ] docker-publish main-branch hang root-cause + fix (C3 v1.4.15 only fixed tag-path)
- Detailed report: `.planning/phase-C-report.md`

## Wave D — Multi-agent QA + Product-Lead

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review (Apple Health benchmarking lens)
- [ ] senior-dev review
- [ ] simplify
- [ ] Product Lead — state of app, biggest items, v1.5 roadmap, follow-on initiatives
- [ ] Reconcile applies CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-report.md` + `product-lead-review.md`

## Phase E — Release v1.4.16

- [ ] Pre-release verify
- [ ] Bump package.json + CHANGELOG
- [ ] Tag + push v1.4.16
- [ ] GHCR build (verify both main + tag green; C3 v1.4.16 fix may finally help main)
- [ ] Coolify deploy
- [ ] /api/version=1.4.16 confirmed
- [ ] Production smoke
- [ ] GH release
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1416-summary.md` (Marc-Brief)
- Detailed report: `.planning/phase-E-report.md`

---

## Previous milestone — v1.4.15 (completed 2026-05-09T22:50+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.15` · image digest
`sha256:ace7d441f47b…` (was `0ced46004a54…` on v1.4.14).

Full Marc-Brief, commit table, deferred items, CI/prod state and
Phase-D reconcile detail: `docs/audit/v1415-summary.md`. Backlog seeded
to `.planning/v1416-backlog.md` (8 deferred HIGH + 39 MED/LOW + 4
simplify-no + 3 process items).

Phases run during v1.4.15 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.4.15)
- Phase A1–A5 + B-mobile — Quick fixes (nav, admin overview, quick-add labels, dashboard analytics, mobile audit + fix-application)
- Phase B1–B6 — Bigger features (backup completeness, Withings/moodLog robustness, notification reliability, achievements UI, onboarding tour, doctor-report v2)
- Phase C1–C5 — Hardening (AI/Codex schema + slug-drift, Coolify auto-deploy, CI/e2e reliability, i18n parity, empty-states audit)
- Phase D — Multi-agent QA (5 reviewers + reconcile; 0 CRITICAL, 5 HIGH fixed inline, 8 HIGH deferred to v1.4.16)
- Phase E1–E3 — Release (v1.4.15 tag, GHCR, host-side retag deploy, docs+landing sync, summary)

Marathon recurring meta: per-agent git-worktree adoption deferred to
v1.4.16 (commit-message drift recurred across A2, A4, B1, B-mobile, B2,
B3, B4, C1, C5).

---

## Status block — Phase 0 (v1.4.16)

- 2026-05-09T23:12:52+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.16 marathon (Wave A: A1-A8, Wave B: B1-B7, Wave C
  catch-up, Wave D multi-agent QA + Product-Lead, Phase E release).
  Previous v1.4.15 entries archived above. Working tree was carrying
  re-run-prettier corruption on 22 .planning/ files (markdown list-
  marker `+` flipped to `-`, breaking content) — discarded via
  `git checkout -- .planning/` before scaffold; tracked files clean.
  Untracked v1.4.14/v1.4.15 leftover phase reports (15 files) left in
  place — they belong to previous milestones, not v1.4.16. Phase 0
  commit contains only `.planning/STATE.md`, `.planning/ROADMAP.md`,
  `.planning/phase-0-report.md`. Marc-status: speed matters.
