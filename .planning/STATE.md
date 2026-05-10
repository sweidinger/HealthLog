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

- [x] Create `develop` from cleaned `main` HEAD (`a1cf9bc`)
- [x] Push `develop` to origin (tracking set up)
- [x] GHCR workflow verified — only `branches: [main]` + `tags: ['v*']` push paths build/publish; PRs to `main` build but do not push; develop is build-free
- [x] All v1.4.20 commits target `develop`; release-merge to `main` only at Phase E
- Detailed report: `.planning/phase-F1-report.md`

### F2 — Document branch + release model

- [x] Extend `CONTRIBUTING.md` with branch flow + ASCII diagram (this branch)
- [x] Mirror page on healthlog-docs at `/contributing/branch-model/` (`5d96861` on healthlog-docs/main)
- [x] User-vs-contributor distinction explicit in both surfaces
- Detailed report: `.planning/phase-F2-report.md`

### FX — User-facing artifact cleanup (PII + jargon + German leaks)

Combined sweep across HealthLog main repo + healthlog-docs + healthlog-landing
(F3 + F4 + new PII rule consolidated into one wave).

- [x] HealthLog main repo: 20 files scrubbed, `a1cf9bc` on origin/main
      (CHANGELOG.md, docs/audit/v146 / v1414 / v1415 / v1416 / v1418 /
      v1419, docs/codex-protocol-spec.md, docs/migration/, docs/ops/)
- [x] healthlog-docs: 7 files scrubbed, `782862b` on origin/main
      (api/ examples replaced "marc" → "alice", DE leaks fixed)
- [x] healthlog-landing: 1 file scrubbed, `9b31083` on origin/main
      (JSON-LD author block depersonalised)
- [ ] GH releases v1.4.14–v1.4.19: republish bodies from cleaned
      CHANGELOG sections (see Phase E pipeline)
- [ ] Source-comment sweep (`src/` has 191 `Marc` references in
      maintainer comments) — defer to v1.4.21 backlog as low-priority
- [ ] DE+EN bilingual CHANGELOG entries (v1.4.15 era) — defer; larger
      rewrite, captured in v1.4.21 backlog
- Detailed report: `.planning/phase-FX-report.md`

### F5 — Best-practice GitHub repo audit

- [x] CODE_OF_CONDUCT.md (Contributor Covenant 2.1, `e7b6b27`)
- [x] Issue + PR templates (`.github/ISSUE_TEMPLATE/*.yml`, `PULL_REQUEST_TEMPLATE.md`, `072941b`)
- [x] Dependabot expanded to github-actions + docker (`779e5a3`)
- [x] package.json metadata: description, license, homepage, repository, bugs, keywords (`f7977d1`)
- [x] LOW carry-over (README badges, FUNDING.yml, repo-root tidy) deferred to `.planning/v1421-backlog.md`
- Detailed report: `.planning/phase-F5-report.md`
- Note: initial sub-agent dispatch hit a content-filter block on the CoC text; refactored to inline execution (download CoC verbatim from contributor-covenant.org).

### F6 — Multi-agent QA on new docs

- [x] 38 docs site pages cross-checked against the live app (v1.4.19), CHANGELOG, `.env.example`, Dockerfile, docker-compose, docker-publish workflow
- [x] CRITICAL fixed inline: `19eb8de` (S3 env-var names + arm64 build claim removed) on healthlog-docs/main
- [x] HIGH fixed inline: `3d3ea21` (achievement count 38 → 59, `/admin/<section>` paths, AI rate-limit 2/h → 10/h, default-locale flip, comparison-overlay scope) on healthlog-docs/main
- [x] 9 MED + 5 LOW deferred to `.planning/v1421-backlog.md` "Docs site audit" section
- [x] Two flagged-but-uncertain items captured for maintainer review
- Detailed report: `.planning/phase-F6-report.md`

## Wave B — Insights redesign with AI Coach (sequential)

Per `.planning/phase-D-v1419-product-lead-review.md`. Each phase
ships behind a feature flag and unlocks independently.

### B1 — Hero strip + Daily Briefing + Suggested-prompts (~3-5 days)

- [x] Replace `<InsightsPageHero>` with new hero strip (greeting,
      action row + suggested-prompt strip; Daily Briefing card mounts
      full-width below the hero)
- [x] New `src/components/insights/{hero-strip,daily-briefing,
      suggested-prompts}.tsx`
- [x] Extend `aiInsightResponseSchema` with `dailyBriefing`
      (`paragraph`, `keyFindings[]`)
- [x] PROMPT_VERSION bump 4.19.0 → 4.20.0
- [~] Apple Health gated tiles — descoped per `phase-D-v1419-product-
      lead-review.md` decision. The 4-vitals tile row from the artboard
      uses BP / Weight / Pulse / Mood (all data already in the app);
      HRV / Sleep / Resting-HR tiles defer to v1.5 / iOS app. The B1
      tile row itself (Vitals at-a-glance) is deferred to a later
      B-phase since it duplicates the per-section status cards below
      — see B1 report for the rationale.
- Detailed report: `.planning/phase-B1-v1420-report.md` (the older
  `phase-B1-report.md` is from the v1.4.18 achievements marathon)

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
