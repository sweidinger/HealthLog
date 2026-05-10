# HealthLog v1.4.18 — roadmap

Milestone: **v1.4.18** (kicked off 2026-05-10)
Latest tag at start: v1.4.17 (live in prod, image digest
`sha256:936e9cf2…`)

| Phase | Goal                                                                                                           | State   |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.18, git sanity, single chore commit                                         | done    |
| A1    | BD-Zielbereich tile — 7T/30T sub-values render real numbers (currently "—" even with data)                     | pending |
| A2    | `/admin/api-tokens` table scrollbar (3rd attempt) — Playwright live-verify against prod, fix actual overflow   | pending |
| A3    | Chart visual revert + per-chart toggles — drop gradient/emoji/auto-mean, ship 3 opt-in overlay toggles         | pending |
| B1    | Achievements expansion — research + 15-25 new, hidden Easter-eggs, lock filter, hidden cards                   | pending |
| D     | Multi-agent QA + Product-Lead — code-reviewer, security, design (Apple-Health lens), senior, simplify, product | pending |
| E     | Release v1.4.18 — bump, CHANGELOG, tag, GHCR, deploy, /api/version=1.4.18, smoke, docs+landing sync            | pending |

Stop conditions: production red, large un-spec'd issue, context cutoff,
or budget short of polish — write status doc, do not auto-rollback.

Time-runs-short minimum to ship v1.4.18: Wave A (any subset) + Wave D

- Phase E. Wave B (B1 achievements) is deferrable to v1.4.19 if context
  budget tightens.

Phase 0 spec for this marathon: orchestrator user message in this
session (not stored to disk).

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
