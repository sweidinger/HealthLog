# v1.4.22 marathon — state log

Status: Wave 6 — release shipped (live in prod)
Last update: 2026-05-10T22:46+02:00

> Previous patch: v1.4.21 live (image digest
> `sha256:4e818d44702c…`, `/api/version=1.4.21`).
> v1.4.22 = big polishing release before v1.5 iOS. Closes ALL known
> bugs + applies ALL deferred items from `.planning/v1421-backlog.md`
> so the iOS app builds on a clean foundation.

## Wave 1 — Research + probe (parallel)

Per `feedback_research_before_complex_features.md`, deep-fix work on
4-attempt bugs (BD-Zielbereich, api-tokens scrollbar) + Coach prompt
rewrite needs research first.

### W1a — Playwright PROD probe + token-leak hunt

- [ ] BD-Zielbereich tile rendering against PROD with maintainer
      session (4-attempt bug pattern: probe before patching)
- [ ] Admin / api-tokens scrollbar at multiple viewports (5th attempt)
- [ ] Raw `Metrik <Type>` token leaks in Recommendations / Findings
- [ ] Targets / Zielwerte page screenshot for upgrade brainstorm
- [ ] Inventory `.planning/v1421-backlog.md` items by complexity
- Detailed report: `.planning/phase-W1a-report.md`

### W1b — Health-coach prompt research

- [ ] Benchmark health-coach / motivational-interviewing prompt
      patterns (Apple Health Coaching, Oura, Whoop, …)
- [ ] Define "natural prose first, evidence collapsible" structure
      with concrete EN + DE drafts
- [ ] PROMPT_VERSION 4.20.2 → 4.22.0 (significant Coach tone shift)
- Detailed report: `.planning/phase-W1b-coach-prompt-research.md`

## Wave 2 — Insights surface polish

### A1 — BD-Zielbereich 5th attempt

- [x] Headline re-anchored to `windows.last30Days?.pct`; all-time
      surfaced as `bpInTargetPctAllTime` for the new sub-row
- [x] Integration test pins the route contract
- Detailed report: `.planning/phase-W2-report.md`

### A2 — BD-Kachel feature parity

- [x] Trend arrow + 7-day-trend chip + comparison overlay parity
      (synthesised slope from 7d/30d delta); `<TrendCard>` extended
      with optional `avgAllTime` sub-value

### A3 — Comparison-Toggle → global Settings

- [x] On-surface `<CompareToggle />` removed from `/insights`;
      Settings → Dashboard already carries the canonical picker
- [x] `User.dashboardWidgetsJson.comparisonBaseline` field already
      exists (v1.4.16 phase B8) — every chart still consumes it

### A4 — Insights layout grid normalisation

- [x] Row-fill rule: BP / weight / medications grids collapse to
      full-width when only one card has data
- [x] Trends row equal heights via `min-h-[300px]`
- [x] `<CorrelationRow>` drops insufficient-data tiles; zero ok
      cards hides the row entirely

### A5 — Section heading + tab rename

- [x] "Muster" → "Zusammenhänge" (DE) / "Patterns" → "Relationships"
      (EN). Picked Zusammenhänge over Trends because the row above
      already uses Trends.
- [x] `<InsightsSectionNav>` lifted above the hero strip (sticky
      scroll-anchored; tabs visible first)

### A6 — Raw `Metrik <Type>` token leak fix

- [x] `<RecommendationCard>` text wrapped in `stripChartTokens()`
- [x] DE `componentMood`/`componentBp`/`componentCompliance` renamed
      to German nouns; i18n-integrity test pins the contract

## Wave 3 — Coach polish

### B1 — Prompt rewrite

- [x] Adopt W1b research output: natural prose-first, motivational,
      conservative, evidence-grounded
- [x] PROMPT_VERSION 4.22.0; EN + DE
- [x] Coach-specific test suite covering tone + evidence-collapsible
      pattern
- Detailed report: `.planning/phase-W3-report.md`

### B2 — Collapsible provenance + values

- [x] Move inline raw values out of prose into a
      "Worauf bezieht sich das?" expandable below each assistant
      message; `---KEYVALUES---` … `---END---` sentinel stripped
      server-side, parsed into `provenance.keyValues`
- [x] Source chips stay visible; values reveal on click

### B3 — User avatar = Gravatar (parity)

- [x] Same dimensions as Coach avatar
- [x] Reuses existing `gravatarUrl` from `/api/auth/me`; initials
      fallback when no Gravatar configured

### B4 — Disclaimer move

- [x] "Coach replies are generated. Clinical decisions belong with
      your doctor." moves from below input → sources rail footer
- [x] "Coach reads only your connected data" caption replaced by the
      disclaimer so the source picker stands alone

### B5 — Settings cog wire-or-remove

- [x] Removed for v1.4.22; per-user prompt-tuning surface deferred
      to v1.4.23 (no dead buttons in this release)

## Wave 4 — Other surfaces + backlog cleanup

### C1 — Zielwerte page upgrade

- [x] 30-day sparkline + Δ-vs-last-month caption per card (Direction
      A from W1a §4). Reuses shared HealthChart styling via a
      dependency-free inline SVG; API returns `points30d` +
      `deltaVsLastMonth`. BMI derives both from the weight series.

### C2 — Admin / api-tokens scrollbar 5th attempt

- [x] Live Playwright probe confirmed `whitespace-nowrap` on the date
      `<td>`s was the residual culprit (W1a §2). Dropped the two
      classes; date+time wraps to two lines on narrow viewports.

### C3 — Coolify image-digest auto-deploy

- [x] Workflow appends `?force=true` to the deploy webhook so doc-only
      pushes still trigger a registry-digest check. Maintainer-side
      toggle ("Watch image registry for new digests") documented in
      `.planning/coolify-auto-deploy-howto.md` — one UI flip.

### C4 — AuthShell post-hydration redirect flicker

- [x] Redirect lives in `proxy.ts`. Auth routes mirror
      `onboardingCompletedAt` into a non-httpOnly `hl_onboarding`
      cookie so the proxy can short-circuit before hydration. The
      e2e onboarding-flicker spec dropped its workaround.

### C5 — node-26-alpine bump

- [x] Dependabot PR #162 closed with reasoning. node:26-alpine ships
      without corepack pre-installed; Next.js 16 also still pins
      node 22 LTS as the supported minimum. Reopen when the framework
      bumps its node-version requirement.

### D — `.planning/v1421-backlog.md` cleanup wave

Apply or confirm-defer every item:

- [x] Phase D reconcile carry-over (22 MED + 16 LOW + 4 simplify-maybe)
- [x] FX carry-overs:
  - [x] 191 `Marc` references swept across `src/` (test fixtures kept
        as opaque test data per brief)
  - [x] DE+EN bilingual CHANGELOG entries (v1.4.14 + v1.4.15) reduced
        to English-only
  - [x] `CLAUDE.md` renamed to `CONTRIBUTING-AI.md` so the filename
        is not AI-vendor-specific; `AGENTS.md` stays for multi-agent
        compatibility. `CONTRIBUTING.md` reference updated.

### E2E fix wave (already on develop)

- [x] 5 commits on develop from the v1.4.21 follow-up; release-merge
      brings them into main when v1.4.22 ships

## Wave 5 — Multi-agent QA + Product-Lead review

- [x] code-reviewer (`.planning/phase-W5-v1422-code-review.md` — 0 CRIT, 2 HIGH, 4 MED, 5 LOW)
- [x] security review (`.planning/phase-W5-v1422-security-review.md` — 0 CRIT, 0 HIGH, 2 MED, 4 LOW)
- [x] design / UX review (`.planning/phase-W5-v1422-design-review.md` — 0 CRIT, 3 HIGH, 7 MED, 5 LOW)
- [x] senior-dev review (`.planning/phase-W5-v1422-senior-dev-review.md` — 0 CRIT, 2 HIGH, 5 MED, 4 LOW)
- [x] simplify (`.planning/phase-W5-v1422-simplify-review.md` — 5 apply-yes, 4 apply-maybe, 6 apply-no)
- [x] Product Lead — v1.5 plan refresh based on v1.4.22 state (`.planning/phase-W5-v1422-product-lead-review.md`)
- [x] Reconcile applied CRITICAL + HIGH; defer MED/LOW with reasoning (10 commits; report at `.planning/phase-W5-v1422-reconcile-report.md`; backlog at `.planning/v1422-backlog.md`)

## Wave 6 — Release v1.4.22

- [x] Pre-release verify (typecheck, lint, test, integration,
      format, build) — 2111 unit tests / 89 integration tests
      passing; lint baseline 15 warnings; typecheck clean
- [x] Bump `package.json` 1.4.21 → 1.4.22 + CHANGELOG
      (commit `d71e879`)
- [x] Release-merge develop → main (commit `005fed0`)
- [x] Tag + push v1.4.22 (annotated tag `f4ebd41`)
- [x] GHCR build green (workflow run `25639069964`)
- [x] Coolify deploy — fell back to host-side SSH retag.
      `COOLIFY_WEBHOOK` / `COOLIFY_TOKEN` repo secrets aren't
      configured so the workflow auto-deploy step skipped; the
      Coolify MCP `force=true` queued deploy didn't refresh the
      digest within 5 minutes (same `:latest` pinning bug from
      v1.4.21). Image digest
      `sha256:865154614303fdc362ee3941776f73ec0f60e1f16112ec272a75cbbe28e2cffb`
- [x] /api/version=1.4.22 confirmed at 2026-05-10T22:43:50+02:00
- [x] Production smoke — all 6 gated routes return 307 →
      `/auth/login`; `/api/version` returns 1.4.22
- [x] GH release —
      https://github.com/MBombeck/HealthLog/releases/tag/v1.4.22
- [x] Docs site + landing site sync (healthlog-docs `9fd7aeb`,
      healthlog-landing `743600f`)
- [x] `docs/audit/v1422-summary.md` (release brief, commit
      `65523de` on main)
- [x] v1.5 plan refreshed for the iOS push at
      `.planning/phase-W5-v1422-product-lead-review.md`
