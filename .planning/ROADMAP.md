# HealthLog v1.4.15 — roadmap

Milestone: **v1.4.15** (kicked off 2026-05-09)
Latest tag at start: v1.4.14 (live in prod, image digest `0ced46004a54…`)

| Phase | Goal                                                                                          | State   |
| ----- | --------------------------------------------------------------------------------------------- | ------- |
| 0     | Bootstrap — STATE+ROADMAP for v1.4.15, git/CI sanity, single chore commit                     | done    |
| A1    | Nav conditionals + sidebar context-awareness (bug-report toggle, skip-link, admin sub-items)  | pending |
| A2    | `/admin` overview redesign + `/admin/api-tokens` responsive table                             | pending |
| A3    | Quick-add labels disambiguation + Stimmung-Card mobile fix + onboarding flicker               | pending |
| A4    | Dashboard analytics fixes (BD-Zielbereich 0%, Medikamente graph, Stimmung agg, 7-Tage-Trend)  | pending |
| A5    | Mobile UX audit + chart scroll-lockup fix                                                     | pending |
| B1    | Backup completeness — restore, download, upload, audit, docs                                  | pending |
| B2    | Withings + moodLog sync robustness — status UI, refresh rotation, telegram on fail, audit    | pending |
| B3    | Notification reliability — auto-disable on 410, exp backoff, status visible                   | pending |
| B4    | Achievements UI — surface in dashboard or dedicated page, unlocked-at timestamp               | pending |
| B5    | Onboarding tour first-run — welcome flow after passkey registration, skippable                | pending |
| B6    | Doctor-report v2 — configurable date range, practice-name on cover                            | pending |
| C1    | AI/Codex hardening — provider abstraction, JSON-schema, citations, scope, slug-drift defense  | pending |
| C2    | Auto-deployment — Coolify webhook on GHCR push, failure-notify, self-tested via next release  | pending |
| C3    | CI/e2e reliability audit — root-cause flaky specs, ensure docker-publish always builds       | pending |
| C4    | i18n coverage audit — `admin.section.<slug>.*` EN+DE parity AND non-empty test guards         | pending |
| C5    | Empty-states audit — `/admin/users`, `/admin/backups`, dashboard for very-new users           | pending |
| D     | Multi-agent QA (parallel, write-only) — code-review, security, design, senior-dev, simplify   | pending |
| E     | Release v1.4.15 — bump, CHANGELOG, tag, GHCR, auto-deploy via C2, /api/version=1.4.15, smoke  | pending |

Stop conditions: production red, large un-spec'd issue, context cutoff,
or budget short of polish — write status doc, do not auto-rollback.

Time-runs-short minimum to ship v1.4.15: Phase A (any subset) + Phase D
+ Phase E. Phases B1-B6 + C1-C5 are deferrable to v1.4.16 if context
budget tightens.

Phase 0 spec for this marathon: orchestrator user message in this
session (not stored to disk).

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
