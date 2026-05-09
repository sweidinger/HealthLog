# HealthLog v1.4.16 — roadmap

Milestone: **v1.4.16** (kicked off 2026-05-09)
Latest tag at start: v1.4.15 (live in prod, image digest `sha256:ace7d441f47b…`)

| Phase | Goal                                                                                                              | State   |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.16, git/CI sanity, single chore commit                                         | done    |
| A1    | Sidebar admin-expand bug — Admin nav from non-admin route + Gravatar dropdown side-effects                        | pending |
| A2    | BD-Zielbereich real-fix (regression from v1.4.15 A4) — root-cause + E2E                                           | pending |
| A3    | `/admin/api-tokens` table responsive (still scrolling) — card-list mobile fallback                                | pending |
| A4    | "7-Tage-Schnitt" → "7-Tage-Trend" DE + indicator on ALL charts incl. mood + medication + insights                 | pending |
| A5    | Top-tile-selector real-fix (regression from v1.4.15 A4) — investigate stale-read or missing wire                  | pending |
| A6    | Medication-chart 7d-trend + target-range — match other charts                                                     | pending |
| A7    | AI Generator rate-limit 10/h + cache-invalidate-on-new                                                            | pending |
| A8    | Umlaute encoding bug ("Nrnberg" → "Nürnberg") + login-overview UTF-8 audit                                        | pending |
| B1    | Insights/Charts Apple-Health-style visual leap — gradients, animation, slide-to-compare                           | pending |
| B2    | AI provider settings UX cleanup — single pulldown-driven form, no top/bottom split                                | pending |
| B3    | Admin System-Status host-load chart — CPU/memory/disk-io graph last 2h                                            | pending |
| B4    | Admin logs visibility deepening — filterable audit log + structured wide-event tail                               | pending |
| B5a   | Medical-reference grounding — AHA / ESC / ESH / WHO target ranges as system context + UI citations                | pending |
| B5b   | Multi-provider redundancy — try-each-on-hard-failure, configurable fallback order                                 | pending |
| B5c   | Per-recommendation explainability — WHY / WINDOW / CITATIONS card with mini-chart                                 | pending |
| B5d   | Confidence score per recommendation — 0-100 from sufficiency / recency / signal strength                          | pending |
| B5e   | User-feedback loop — thumbs up/down persisted to RecommendationFeedback, fed into prompt tuning                   | pending |
| B6    | Settings naming-audit — stringency, consistency, no double naming                                                 | pending |
| B7    | Settings → Export menu (Arztbrief consolidated) — new `/settings/export` route                                    | pending |
| B8    | Extended comparison views — Vormonat / Vorjahr overlay across charts + tiles + insights                           | pending |
| C     | Catch-up — 8 deferred HIGH + 5 mobile MED + Coolify image-digest trigger + docker-publish hang                    | pending |
| D     | Multi-agent QA + Product-Lead — code-review, security, design (Apple-Health lens), senior, simplify, product-lead | pending |
| E     | Release v1.4.16 — bump, CHANGELOG, tag, GHCR, deploy, /api/version=1.4.16, smoke, docs+landing sync               | pending |

Stop conditions: production red, large un-spec'd issue, context cutoff,
or budget short of polish — write status doc, do not auto-rollback.

Time-runs-short minimum to ship v1.4.16: Wave A (any subset) + Wave D

- Phase E. Wave B (B1-B8) and Wave C catch-up are deferrable to v1.4.17
  if context budget tightens.

Phase 0 spec for this marathon: orchestrator user message in this
session (not stored to disk).

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
Full report: `docs/audit/v1415-summary.md`. v1.4.16 backlog seeded at
`.planning/v1416-backlog.md`.

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
