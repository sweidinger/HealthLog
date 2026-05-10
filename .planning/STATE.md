# v1.4.18 marathon — state log

Status: phase-0-done
Last update: 2026-05-10T10:02+02:00

> Previous milestone: v1.4.17 hotfix shipped (`/insights` TypeError fix);
> v1.4.16 full release at `docs/audit/v1416-summary.md`.

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.18
- [x] git status clean
- Result: ok / commit `<sha>`
- Detailed report: `.planning/phase-0-report.md`

## Wave A — Quick fixes (parallel buckets)

### A1 — BD-Zielbereich tile 7T/30T sub-values

- [x] Investigate why "7T: —" / "30T: —" render even when user has data
- [x] Fix data source / aggregation for the sub-values
- [x] E2E test against tile rendering with real measurement data
- Detailed report: `.planning/phase-A1-report.md`
- Status: 2026-05-09T10:15+02:00 — done. Root cause was an
  unfinished tile wire: `/api/analytics` only computed a single
  30-day `bpInTargetPct`, and the dashboard tile passed
  `avg7={null}, avg30={null}` so the sub-values rendered "—" no
  matter how much data the user had. Added a windowed helper
  `computeBpInTargetWindows()` (re-uses the v1.4.16 A2 ceiling
  predicate, filters input by `measuredAt`), surfaced
  `bpInTargetPct7d` / `bpInTargetPct30d` from the route, and wired
  them through the tile. 6 new unit tests + 2 new testcontainer
  integration tests, all green. Commit `23363ca` on origin/main.

### A2 — `/admin/api-tokens` table scrollbar (3rd attempt, Playwright live-verified)

- [x] Inspect prod (https://healthlog.bombeck.io/admin/api-tokens) at
      Pixel 5 viewport with Playwright headless using Marc's session
      cookie `cmox4d6fj000101p8w9ykhcnm`
- [x] Identify the exact element causing horizontal overflow (could be
      page-level, not table-level)
- [x] Fix the actual overflow source (not just table column-hide which
      earlier attempts already did)
- [x] Playwright e2e against PROD asserts no horizontal scroll at 393×851
- Detailed report: `.planning/phase-A2-report.md`
- Status: 2026-05-10T10:21+02:00 — done. Production probe at Pixel-5
  with Marc's session pinned the painted scrollbar to the AdminShell
  mobile section strip (13 entries, scrollWidth ~1700 vs clientWidth
  ~360), NOT the api-tokens table. Every previous attempt fixed the
  wrong component because the strip sits right above the api-tokens
  card. Added `no-scrollbar` utility to globals.css and applied to
  both AdminShell + SettingsShell mobile strips (same defect, same
  pattern); swipe + keyboard-arrow scrolling preserved. Document-
  level overflow already 0 in prod
  (innerWidth=scrollWidth=393). Tests: 1559/1559, typecheck clean,
  lint 0/12-baseline. New AdminShell unit suite + settings-shell
  assertion + e2e regression guard. Commit `3e16074` on origin/main.

### A3 — Chart visual revert + per-chart toggles

- [x] Remove gradient-fill background (B1a `<ChartLinearGradient>` +
      chart wrapper area-fill)
- [x] Remove emoji/smiley glyphs from mood-chart data points (replace
      with simple dots or numeric)
- [x] Remove auto-overlay personal-baseline / mean line (only show when
      actively requested)
- [x] Add per-chart overlay-controls component: 3 toggles
      (showTrendIndicator / showTrendArrow / showTargetRange) per chart
- [x] Persist per-user per-chart overlay state (extended
      dashboardLayout JSON with `chartOverlayPrefs`, no Prisma
      migration; new PUT `/api/dashboard/chart-overlay-prefs`)
- [x] Default state: all overlays OFF (clean line is the default)
- [x] Keep the v1.4.16 wins that Marc didn't reject: smooth
      interpolation, rich tooltip, animation-on-render
- Detailed report: `.planning/phase-A3-report.md`
- Status: 2026-05-09T10:36+02:00 — done. Six atomic commits on
  origin/main: gradient-fill revert + chart-gradient module deleted,
  mood-chart emoji glyphs replaced with plain dots, personal-baseline
  ReferenceLine gated behind the Trend toggle on health-chart and
  mood-chart, new `chart-overlay-controls.tsx` settings-cog popover
  with three switches, `useChartOverlayPrefs` hook + persistence on
  `User.dashboardWidgetsJson.chartOverlayPrefs` (mirrors B8 pattern,
  migration-free), Playwright + vitest coverage. Tests:
  1569/1569 + integration 63/63, typecheck clean, lint 12/12 baseline
  warnings. Worktree `../HealthLog-a3` on branch
  `agent/a3-charts-revert`.

## Wave B — Achievements expansion (with research)

### B1 — Achievements expansion

- [x] Research what achievements make sense for HealthLog's tracked
      metrics (BP / weight / pulse / mood / medication / streaks /
      consistency / first-time / milestone)
- [x] Benchmark Apple Health badges, Withings, Oura — what works in
      consumer health
- [x] Author the new achievement set (15 public, target was 15-25)
- [x] Hidden / Easter-egg achievements (6, target was 5-8)
- [x] Discovery filter: locked public badges only render when the
      user has data for the metric; already-unlocked + hidden always
      render; summary recomputed from the visible set so headline
      counters match the rendered list.
- [x] Hidden achievements paint opaque "Hidden achievement" cards;
      real strings never reach the DOM until unlock; toast on unlock
      uses a longer Sparkles celebration with a localized "you
      unlocked a hidden achievement!" headline.
- [x] Result: roster 38 → 59 (+21 = 15 public + 6 hidden). Tests:
      1598/1598 unit, 62/62 integration, typecheck clean, lint
      unchanged. Commits `75c74f1...e75ea75` on origin/main.
- Detailed report: `.planning/phase-B1-report.md`

## Wave D — QA + Product-Lead review

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review (Apple Health benchmarking lens; verify
      chart-revert is clean, no leftover gradients)
- [ ] senior-dev review
- [ ] simplify
- [ ] Product Lead — state of app, biggest items since v1.4.16, v1.5
      roadmap update
- [ ] Reconcile applies CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-report.md` +
  `.planning/product-lead-review.md`

## Phase E — Release v1.4.18

- [ ] Pre-release verify
- [ ] Bump package.json + CHANGELOG
- [ ] Tag + push v1.4.18
- [ ] GHCR build green (both main + tag)
- [ ] Coolify deploy
- [ ] /api/version=1.4.18 confirmed
- [ ] Production smoke
- [ ] GH release
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1418-summary.md` (Marc-Brief)
- Detailed report: `.planning/phase-E-report.md`

---

## Previous milestone — v1.4.17 hotfix (live 2026-05-10T07:58+00:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.17` · image
digest `sha256:936e9cf2…` (was v1.4.16: `sha256:05f8a126d639…`).

Triggered by Marc's `/insights` crash 6 hours after v1.4.16 went live.
Cached pre-strict insight blob (v1.4.14 shape: `{changed, stable,
drivers, nextSteps, confidence, limitations}`) fell through
`safeParse(insightResultSchema)` because the route surfaces the raw
blob when validation fails; rich `<InsightAdvisorCard>` then called
`stripChartTokens(undefined)` and crashed.

Fix:
- `isLegacyInsightPayload()` now flags blobs missing both `summary`
  AND `recommendations[]` (the v1.4.14 shape) so the API surfaces
  `legacyPayload: true` correctly.
- `<InsightAdvisorCard>` short-circuits to a self-contained
  legacy-payload card with the regenerate CTA when `legacyPayload` is
  set OR when the shape is unrenderable.
- Defense-in-depth: `stripChartTokens()` and `parseChartTokens()`
  treat null/undefined as empty string / empty array.

Audit (`git grep -nE '\.replace\(' src/`): 82 hits, only the crash
site is fragile. Audit doc: `.planning/v1417-replace-audit.md`.

Verification: `pnpm typecheck` 0 errors, `pnpm lint` 0 errors / 12
pre-existing warnings, `pnpm test` 1547/1547 (+7 defensive tests),
`pnpm test:integration` 59/59.

Commits on origin/main:
- `79bfa27 fix(insights): handle legacy cached payload without rationale (regenerate CTA)`
- `adab80a chore(release): v1.4.17`
- `da7070e style(insights): prettier sweep on legacy-payload hotfix files`

GH release: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.17.
Detailed report: `.planning/phase-v1417-hotfix-report.md`.

---

## Previous milestone — v1.4.16 (completed 2026-05-10T04:05+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.16` · image
digest `sha256:05f8a126d639…` (was v1.4.15: `sha256:ace7d441f47b…`).

Full Marc-Brief, commit table, deferred items, CI/prod state and
Phase-D reconcile detail: `docs/audit/v1416-summary.md`. Backlog seeded
to `.planning/v15-backlog.md` (11 deferred HIGH + tactical follow-ons +
Product-Lead strategic v1.5 plan).

Phases run during v1.4.16 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.4.16)
- Wave A — A1-A8 quick fixes (admin nav, BD-Zielbereich, api-tokens
  responsive, 7-Tage-Trend rename, top-tile selector, medication chart
  parity, AI rate-limit, umlaute fix, long-window split-half delta)
- Wave B — B1a/b chart + insights polish, B2 AI provider UX, B3
  host-load chart, B4 audit-log + app-log preview, B5a-e medical
  references / fallback chain / explainability / confidence /
  feedback, B6 settings naming audit, B7 export consolidation, B8
  comparison overlay
- Wave C — Catch-up (CI fix, 5 of 8 deferred HIGH from v1.4.15, 3 of 5
  deferred MED from A5 mobile, docker-publish drop qemu-arm64)
- Wave D — Multi-agent QA + reconcile (3 CRITICAL cleared, 9 HIGH
  fixed inline, 11 HIGH deferred to v1.5 backlog)
- Phase E1-E3 — Release (v1.4.16 tag, GHCR both green, Coolify deploy
  with retag-on-host fallback, GH release, docs+landing sync,
  Marc-Brief)

Marathon recurring meta: per-agent git-worktree adoption succeeded;
keep the rule.

---

## Status block — Phase 0 (v1.4.18)

- 2026-05-10T10:02+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.18 marathon (Wave A: A1-A3 quick fixes
  including chart visual revert per Marc's gradient/smiley/auto-mean
  feedback, Wave B: B1 achievements expansion with research, Wave D
  multi-agent QA + Product-Lead, Phase E release). Previous v1.4.17
  hotfix and v1.4.16 entries archived above. Working tree carries
  4 untracked stale dotted-segment route directories
  (`src/app/api/export/{full-backup.json,measurements.csv,
  medications.csv,mood.csv}/`) plus 3 untracked v1.4.16 phase
  reports (`phase-E1-report.md`, `phase-E2-report.md`,
  `phase-E3-report.md`) — same call as v1.4.16 Phase 0: leave them
  in place, they belong to previous milestones. Tracked files clean.
  Phase 0 commit contains only `.planning/STATE.md`,
  `.planning/ROADMAP.md`, `.planning/phase-0-report.md`.
