# v1.4.20 marathon — state log

Status: in flight
Last update: 2026-05-10T15:00+02:00

> Previous milestone: v1.4.19 live (image digest
> `sha256:b48f93874cdb…`, `/api/version=1.4.19`).
> v1.4.20 = Insights redesign with AI Coach
> (handoff at `~/Downloads/design_handoff_insights_redesign`).
> v1.5 reserved for iOS app + Apple Health integration.

## Foundation — pre-flight before any feature work

Per `.planning/v1420-marathon-handoff.md`, F1–F6 must complete before
B1 dispatches.

### F0 — Commit dangling v1.4.19 reports + bootstrap v1.4.20 scaffold

- [x] Commit phase-E1-report.md + phase-E3-report.md v1.4.19 updates
- [x] STATE.md replaced with v1.4.20 scaffold; v1.4.19 archived to ROADMAP.md
- [x] ROADMAP.md updated with v1.4.20 milestone + previous-milestone archive

### F1 — Branch model: long-lived `develop`

- [ ] Create `develop` from current `main` HEAD
- [ ] Push `develop` to origin
- [ ] Verify GHCR workflow only fires on `main` push + `v*` tag
- [ ] Set `develop` as default work-target for all v1.4.20 commits
- Detailed report: `.planning/phase-F1-report.md`

### F2 — Document branch + release model

- [ ] Extend `CONTRIBUTING.md` with branch flow + ASCII/Mermaid diagram
- [ ] Mirror page on healthlog-docs (developer / contributor docs)
- [ ] Make user-vs-contributor distinction explicit
- Detailed report: `.planning/phase-F2-report.md`

### F3 — Repo-cleanup audit (jargon sweep)

- [ ] Multi-agent sweep: `CHANGELOG.md`, `docs/audit/`, `docs/`,
      `README.md`, healthlog-docs, healthlog-landing
- [ ] Replace internal jargon (Phase X / Wave Y / marathon /
      sub-agent / autonomous orchestrator / Claude name) with neutral
      language
- [ ] Keep Co-Author trailer on commits (git-meta only)
- [ ] No git history rewrite — only edit current file state
- Detailed report: `.planning/phase-F3-report.md`

### F4 — Release-notes language audit (German leaks)

- [ ] Audit `CHANGELOG.md` v1.4.14–v1.4.19 + GitHub releases + future
      docs/audit/v*-summary.md
- [ ] Translate German leaks to English
- Detailed report: `.planning/phase-F4-report.md`

### F5 — Best-practice GitHub repo audit

- [ ] 2 parallel agents survey repo structure
- [ ] Compare to OSS best-practice (README, LICENSE, CONTRIBUTING,
      CODE_OF_CONDUCT, SECURITY, .github/ISSUE_TEMPLATE,
      PULL_REQUEST_TEMPLATE, badges)
- [ ] Output prioritized list; apply CRITICAL + HIGH inline; defer
      rest to v1.4.21
- Detailed report: `.planning/phase-F5-report.md`

### F6 — Multi-agent QA on new docs

- [ ] After F2 lands: separate agents read dev-vs-prod docs
- [ ] Verify they describe actual deployed state — no incorrect claims
- [ ] Flag and fix anything inaccurate before tag
- Detailed report: `.planning/phase-F6-report.md`

## Wave B — Insights redesign with AI Coach (sequential)

Per `.planning/phase-D-v1419-product-lead-review.md`. Each phase
ships behind a feature flag and unlocks independently.

### B1 — Hero strip + Daily Briefing + Suggested-prompts (~3-5 days)

- [ ] Replace `<InsightsPageHero>` with new hero strip (greeting,
      3 micro-stat tiles, AI Coach entry block, Daily Briefing card)
- [ ] New `src/components/insights/{hero-strip,daily-briefing,
      suggested-prompts}.tsx`
- [ ] Extend `aiInsightResponseSchema` with `dailyBriefing`
      (`paragraph`, `keyFindings[]`)
- [ ] PROMPT_VERSION bump 4.19.0 → 4.20.0
- [ ] Apple Health gated tiles render "Connect Apple Health (iOS app)"
      placeholder until v1.5 ships
- Detailed report: `.planning/phase-B1-report.md`

### B2 — AI Coach panel + streaming chat + persistence (~5-7 days)

- [ ] Drawer overlay over `/insights`; full-page route deferred to v1.5
- [ ] New `POST /api/insights/chat` SSE-streaming endpoint
- [ ] New `src/components/insights/coach-panel/*`
- [ ] New Prisma `CoachConversation` + `CoachMessage` (encrypted
      content, GDPR cascade)
- [ ] Source-chip rows on every assistant message (provenance)
- [ ] Token-budget cap + 20-turn conversation cap
- [ ] Prompt-injection refusal pattern (extend v1.4.15 C1)
- Detailed report: `.planning/phase-B2-report.md`

### B3 — Correlation discovery + Trends row with AI annotations (~3-5 days)

- [ ] 3 pre-defined hypotheses: BP×compliance, mood×pulse,
      weight×weekday
- [ ] New `src/lib/insights/correlations.ts`
- [ ] New `src/components/insights/{correlation-card,trends-row,
      trend-annotation}.tsx`
- [ ] Confidence ≥ 0.95, n ≥ 14, conservative phrasing
- Detailed report: `.planning/phase-B3-report.md`

### B4 — Weekly Report + Storyboard + Mobile passes (~3-4 days)

- [ ] New `/insights/report/[week]` route + `window.print()` export
- [ ] Storyboard 90-day BP timeline with annotations[]
- [ ] Mobile passes: B1 + B2 mobile equivalents (drawer →
      full-screen sheet)
- Detailed report: `.planning/phase-B4-report.md`

### B5 — Personal AI Coach Health Score (~2-3 days)

- [ ] Composite Health Score (0-100): 30% BP-target + 20%
      weight-trend + 20% mood-stability + 30% compliance
- [ ] Three bands (≥75 green, 50–74 yellow, <50 red)
- [ ] "Ask the Coach" CTA opens B2 drawer with prefilled prompt
- Detailed report: `.planning/phase-B5-report.md`

## Wave D — Multi-agent QA + Product-Lead review

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review
- [ ] senior-dev review
- [ ] simplify
- [ ] Product Lead — v1.5 redesign plan
- [ ] Reconcile applied CRITICAL + HIGH; defer MED/LOW to v1.4.21
- Detailed report: `.planning/phase-D-v1420-reconcile-report.md`

## Phase E — Release v1.4.20

- [ ] Pre-release verify (typecheck, lint, test, integration,
      format, build)
- [ ] Bump package.json + CHANGELOG
- [ ] Merge develop → main (release-merge only)
- [ ] Tag + push v1.4.20
- [ ] GHCR build green
- [ ] Coolify deploy
- [ ] /api/version=1.4.20 confirmed
- [ ] Production smoke
- [ ] GH release
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1420-summary.md` (release brief)
- [ ] Update v1.5 plan based on what v1.4.20 learned

---

## Status block — F0 (v1.4.20)

- 2026-05-10T15:00+02:00 — F0 complete. Dangling v1.4.19 release
  reports (`phase-E1-report.md` + `phase-E3-report.md`) committed,
  STATE.md replaced with v1.4.20 scaffold (F1–F6 foundation +
  B1–B5 Insights redesign + Wave D + Phase E), ROADMAP.md updated
  to track v1.4.20 with v1.4.19 archived. Branch model unchanged
  for this commit (still `main`); F1 will introduce `develop`.
