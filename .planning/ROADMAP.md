# HealthLog v1.4.20 — roadmap

Milestone: **v1.4.20** (kicked off 2026-05-10)
Latest tag at start: v1.4.19 (live in prod, image digest
`sha256:b48f93874cdb…`)

| Phase | Goal                                                                                                                                                 | State   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| F0    | Bootstrap — commit dangling v1.4.19 reports, scaffold STATE+ROADMAP for v1.4.20                                                                      | done    |
| FX    | User-facing artifact cleanup — PII (no real names, no health figures), internal jargon, German leaks; CHANGELOG + docs/audit + GH releases + sites   | pending |
| F1    | Branch model — long-lived `develop` from `main` HEAD; GHCR builds on `main` + `v*` only; hotfixes from `main` merge back to both                      | pending |
| F2    | Document branch + release model — extend CONTRIBUTING.md, mirror page on docs site                                                                   | pending |
| F5    | Best-practice GitHub repo audit — README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, .github templates, badges; CRIT/HIGH inline               | pending |
| F6    | Multi-agent QA on new docs — verify they describe actual deployed state                                                                              | pending |
| B1    | Hero strip + Daily Briefing + Suggested-prompts — replace `<InsightsPageHero>`, 3 micro-stat tiles, AI Coach entry, Daily Briefing card               | pending |
| B2    | AI Coach drawer + streaming chat + persistence — SSE endpoint, CoachConversation+CoachMessage models, source-chip provenance, prompt-injection refusals | pending |
| B3    | Correlation discovery + Trends row — 3 hypotheses (BP×compliance, mood×pulse, weight×weekday), AI annotations under trend mini-charts                | pending |
| B4    | Weekly Report + Storyboard + Mobile passes — `/insights/report/[week]`, 90-day BP storyboard, mobile equivalents of B1+B2                            | pending |
| B5    | Personal Health Score — composite 0-100 (BP-target / weight-trend / mood-stability / compliance), 3 bands, "Ask the Coach" CTA                       | pending |
| D     | Multi-agent QA + Product-Lead review — code-reviewer, security, design, senior, simplify, product-lead (v1.5 strategic)                              | pending |
| E     | Release v1.4.20 — develop → main release-merge, bump, CHANGELOG, tag, GHCR, deploy, /api/version=1.4.20, smoke, docs+landing sync                    | pending |

Stop conditions: production red, large un-spec'd issue, context cutoff,
or budget short of polish — write status doc, do not auto-rollback.

Time-runs-short minimum to ship v1.4.20: F0–F2 + FX + B1 + Wave D + Phase E.
B2 (the AI Coach drawer) is the biggest piece; if context tightens, ship
B1+B3+B5 and defer B2+B4 to v1.4.21.

Phase F0 spec for this marathon: `/Users/marc/Projects/HealthLog/.planning/v1420-marathon-handoff.md`.

Reserved next strategic milestones:

- **v1.5** — iOS app + Apple Health integration (handoff at
  `~/Projects/healthlog-iOS`).
- **v1.6+** — Auto-correlation discovery (FDR-controlled), Coach
  full-page route, conversation-driven goal setting.

---

## Previous milestone — v1.4.19 (completed 2026-05-10T12:39:59Z)

| Phase | Goal                                                                                                                                                 | State |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.19                                                                                                                | done  |
| A1    | BD-Zielbereich constant 50% (4th attempt) — live-DB root-cause + integration test                                                                    | done  |
| A2    | Charts mobile audit — universal X-tick density helper, mobile-first stacked headers across HealthChart / MoodChart / MedicationComplianceChart        | done  |
| A3    | `/insights` polish — Comparison-toggle relocated, single page-level refresh, BP/Weight tile strip removed, raw-token leak guarded                    | done  |
| A4    | AI prompt — GROUND RULE 7 forbids default-positivity opener, PROMPT_VERSION 4.16.1 → 4.19.0                                                          | done  |
| A5    | Settings/Integrations status-UI — `<IntegrationStatusPill>` consolidates Withings + Mood Log, divider parity, locale-aware relative-time             | done  |
| A6    | Settings mobile audit — input heights equalised at 36 px, action buttons standardised, Sprache select hoisted to its own row                         | done  |
| A7    | Admin polish — feedback tab strip scrollbar, api-tokens 4th-attempt truncate+tooltip, Einklappen toggle removed, Zielwerte i18n                       | done  |
| A8    | Quality-of-life audit — 78 findings prioritised CRITICAL / HIGH / MED / LOW                                                                          | done  |
| B     | Apply A8 — 6/6 CRITICAL + 21/25 HIGH inline; 31 MED + 16 LOW carried to v1.4.20 backlog                                                              | done  |
| D     | Multi-agent QA (5 reviewers) + Product-Lead → v1.5 redesign plan filed                                                                               | done  |
| E1-E3 | Release v1.4.19 — tag, GHCR build green, host-side retag deploy via fallback (Coolify deploy hung, retried via SSH), GH release, docs+landing sync   | done  |

Milestone completed 2026-05-10T12:39:59Z — v1.4.19 LIVE in prod.
Release brief: `docs/audit/v1419-summary.md`. Backlog seeded to
`.planning/v1420-backlog.md` (carry-over) and v1.5 strategic items in
`.planning/v15-backlog.md` + `.planning/phase-D-v1419-product-lead-review.md`.

---

## Previous milestone — v1.4.18 (completed 2026-05-10T11:45+02:00)

| Phase | Goal                                                                                                       | State |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.18                                                                      | done  |
| A1    | BD-Zielbereich tile — 7T/30T sub-values render real numbers (currently "—" even with data)                 | done  |
| A2    | `/admin/api-tokens` table scrollbar (3rd attempt) — Playwright live-verify against prod, fix actual offender | done  |
| A3    | Chart visual revert + per-chart toggles — drop gradient/emoji/auto-mean, ship 3 opt-in overlay toggles      | done  |
| B1    | Achievements expansion — research + 15-25 new, hidden Easter-eggs, lock filter, hidden cards                | done  |
| D     | Multi-agent QA + Product-Lead — code-reviewer, security, design, senior, simplify, product                  | done  |
| E     | Release v1.4.18 — bump, CHANGELOG, tag, GHCR, deploy, /api/version=1.4.18, smoke, docs+landing sync         | done  |

Marathon completed 2026-05-10T11:45+02:00 — v1.4.18 LIVE in prod.
Full report: `docs/audit/v1418-summary.md`. Backlog seeded to
`.planning/v1419-backlog.md` (tactical) and `.planning/v15-backlog.md`
+ `.planning/phase-D-v1418-product-lead-review.md` (strategic).

---

## Previous milestone — v1.4.17 hotfix (live 2026-05-10T07:58+00:00)

| Phase  | Goal                                                                                                       | State |
| ------ | ---------------------------------------------------------------------------------------------------------- | ----- |
| Hotfix | `/insights` TypeError on legacy cached blob — `isLegacyInsightPayload()` flag + advisor card short-circuit | done  |
| Audit  | `git grep -nE '\.replace\(' src/` — 82 hits scanned, crash site is the only fragile case                   | done  |
| E      | Release v1.4.17 — bump, tag, GHCR, host-side retag deploy, GH release                                      | done  |

Hotfix completed 2026-05-10T07:58+00:00 — v1.4.17 LIVE in prod.
Detailed report: `.planning/phase-v1417-hotfix-report.md`.

---

## Previous milestone — v1.4.16 (completed 2026-05-10T04:05+02:00)

| Phase | Goal                                                                                                  | State |
| ----- | ----------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.16                                                                 | done  |
| A1    | Sidebar admin-expand bug — Admin nav from non-admin route + Gravatar dropdown side-effects            | done  |
| A2    | BD-Zielbereich real-fix (regression from v1.4.15 A4) — root-cause + E2E                               | done  |
| A3    | `/admin/api-tokens` table responsive — card-list mobile fallback                                      | done  |
| A4    | "7-Tage-Schnitt" → "7-Tage-Trend" DE + indicator on ALL charts                                        | done  |
| A5    | Top-tile-selector real-fix — widget-id enum drift fixed                                               | done  |
| A6    | Medication-chart 7d-trend + target-range — match other charts                                         | done  |
| A7    | AI Generator rate-limit 10/h + cache-invalidate-on-new                                                | done  |
| A8    | Umlaute encoding bug + login-overview UTF-8 audit + long-window split-half delta                      | done  |
| B1a   | Charts visual leap — gradients, baseline, rich tooltip, mood emoji glyphs                             | done  |
| B1b   | Insights surface visual leap — page hero, recs grid, summary typography, dashboard preview            | done  |
| B2    | AI provider settings UX cleanup — single pulldown-driven form, fallback chain editor                  | done  |
| B3    | Admin System-Status host-load chart — CPU/memory/disk-io graph last 2h                                | done  |
| B4    | Admin logs visibility deepening — filterable audit log + structured wide-event tail                   | done  |
| B5a   | Medical-reference grounding — AHA / ESC / ESH / WHO bundle + UI citations                             | done  |
| B5b   | Multi-provider redundancy — try-each-on-hard-failure, configurable fallback order                     | done  |
| B5c   | Per-recommendation explainability — WHY / WINDOW / CITATIONS card with mini-chart                     | done  |
| B5d   | Confidence score per recommendation — deterministic 0-100 from sufficiency / recency / signal         | done  |
| B5e   | User-feedback loop — thumbs persisted to RecommendationFeedback + daily aggregator                    | done  |
| B6    | Settings naming-audit — stringency, consistency, no double naming                                     | done  |
| B7    | Settings → Export menu (Arztbrief consolidated) — new `/settings/export` route                        | done  |
| B8    | Extended comparison views — Vormonat / Vorjahr overlay across charts + tiles + insights               | done  |
| C     | Catch-up — 5 of 8 deferred HIGH + 3 of 5 mobile MED + docker-publish drop qemu-arm64                  | done  |
| D     | Multi-agent QA + Product-Lead — code-review, security, design, senior, simplify, product-lead         | done  |
| E1-E3 | Release v1.4.16 — bump, tag, GHCR (both green), host-side retag deploy, GH release, docs+landing sync | done  |

Marathon completed 2026-05-10T04:05+02:00 — v1.4.16 LIVE in prod.
Full report: `docs/audit/v1416-summary.md`. v1.5 backlog seeded at
`.planning/v15-backlog.md`.

---

## Previous milestone — v1.4.15 (completed 2026-05-09T22:50+02:00)

| Phase    | Goal                                                                                                         | State |
| -------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| 0        | Bootstrap — STATE+ROADMAP for v1.4.15                                                                        | done  |
| A1       | Nav conditionals + sidebar context-awareness                                                                 | done  |
| A2       | `/admin` overview redesign + `/admin/api-tokens` responsive                                                  | done  |
| A3       | Quick-add labels + Stimmung-Card mobile + onboarding flicker                                                 | done  |
| A4       | Dashboard analytics fixes (BD-Zielbereich, Medikamente graph, Stimmung agg, 7-Tage-Trend, top-tile selector) | done  |
| A5       | Mobile UX audit + chart scroll-lockup fix                                                                    | done  |
| B-mobile | Mobile audit fix-application (5 commits, 2/2 CRITICAL, 6/8 HIGH)                                             | done  |
| B1       | Backup completeness — restore, download, upload, audit, docs                                                 | done  |
| B2       | Withings + moodLog sync robustness — status UI, refresh rotation, telegram on fail                           | done  |
| B3       | Notification reliability — auto-disable on 410, exp backoff, status visible                                  | done  |
| B4       | Achievements UI — `/achievements` page + dashboard card                                                      | done  |
| B5       | Onboarding tour first-run — spotlight, Esc/arrows, restart from Settings                                     | done  |
| B6       | Doctor-report v2 — configurable date range, practice-name on cover                                           | done  |
| C1       | AI/Codex hardening — provider abstraction, JSON schema, citations, scope, slug-drift defense                 | done  |
| C2       | Auto-deployment — Coolify webhook on GHCR push, failure-notify                                               | done  |
| C3       | CI/e2e reliability audit — root-cause flaky specs, docker-publish cache fix                                  | done  |
| C4       | i18n coverage audit — EN+DE parity, non-empty test guards                                                    | done  |
| C5       | Empty-states audit — 13 surfaces upgraded                                                                    | done  |
| D        | Multi-agent QA (5 reviewers + reconcile)                                                                     | done  |
| E1–E3    | Release v1.4.15 — bump, tag, GHCR, host-side retag deploy, docs+landing sync, Marc-Brief                     | done  |

Marathon completed 2026-05-09T22:50+02:00 — v1.4.15 LIVE in prod.
Full report: `docs/audit/v1415-summary.md`.

---

## Previous milestone — v1.5 (relabelled v1.4.14, completed 2026-05-09)

| Phase | Goal                                                                                                                                   | State |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 0     | Bootstrap — STATE+ROADMAP, git/CI/prod sanity, single chore commit                                                                     | done  |
| 1     | Verify Codex-OAuth end-to-end (device-start shape, prod logs, gpt-5.3-codex slug)                                                      | done  |
| 2     | v1.4.6 deferred backlog — T2.1..T2.7 (wipe scope, DST math, 5xx → 422/503, status-card test, redact regex, Backups view, /admin/users) | done  |
| 3     | End-to-end test coverage — authed dashboard, add-measurement, KI flow, doctor PDF, insights, mobile smoke, axe-core extended           | done  |
| 4     | Performance audit — Playwright capture, `docs/audit/v15-performance.md`, top-3 wins inline                                             | done  |
| 4b    | Admin Panel refactor — `/admin/[section]` dynamic routes mirror Settings; sidebar Admin group; legacy hash redirects; bundle-size win  | done  |
| 5     | UX polish — design-review top-10 friction points, CRITICAL/HIGH triage                                                                 | done  |
| 6     | Multi-agent QA (parallel) — code-reviewer, security, visual/UX, simplify                                                               | done  |
| 7     | Pre-release verification — typecheck / lint / format / test / integration / build / e2e                                                | done  |
| 8     | Release v1.4.14 — rebrand patch deploy (host-side retag, GHCR `:1.4.14`, image digest `0ced46004a54…`)                                 | done  |
| 9     | Docs + landing site sync to v1.4.14                                                                                                    | done  |
| 10    | Backfill GitHub releases v1.4.7..v1.4.13 from CHANGELOG                                                                                | done  |
| 11    | Final summary `docs/audit/v1414-summary.md` with Marc-Brief                                                                            | done  |

Marathon completed 2026-05-09T18:35+02:00 — v1.4.14 LIVE in prod.
Full report: `docs/audit/v1414-summary.md`.
