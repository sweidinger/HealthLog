# HealthLog v1.5 — roadmap

Milestone: **v1.5.0** (overnight 2026-05-09 → 2026-05-10)
Latest tag at start: v1.4.13 (Codex-OAuth model slug `gpt-5` patch)

| Phase | Goal                                                                       | State   |
| ----- | -------------------------------------------------------------------------- | ------- |
| 0     | Bootstrap — STATE+ROADMAP, git/CI/prod sanity, single chore commit         | done    |
| 1     | Verify Codex-OAuth end-to-end (device-start shape, prod logs, gpt-5 slug)  | pending |
| 2     | v1.4.6 deferred backlog — T2.1..T2.7 (wipe scope, DST math, 5xx → 422/503, status-card test, redact regex, Backups view, /admin/users) | pending |
| 3     | End-to-end test coverage — authed dashboard, add-measurement, KI flow, doctor PDF, insights, mobile smoke, axe-core extended | pending |
| 4     | Performance audit — Playwright capture, `docs/audit/v15-performance.md`, top-3 wins inline | pending |
| 4b    | Admin Panel refactor — `/admin/[section]` dynamic routes mirror Settings; sidebar Admin group; legacy hash redirects; bundle-size win | pending |
| 5     | UX polish — design-review top-10 friction points, CRITICAL/HIGH triage     | pending |
| 6     | Multi-agent QA (parallel) — code-reviewer, security, visual/UX, simplify   | pending |
| 7     | Pre-release verification — typecheck / lint / format / test / integration / build / e2e | pending |
| 8     | Release v1.5.0 — bump, CHANGELOG, tag, GHCR, Coolify force-pull, /api/version=1.5.0, smoke screenshots | pending |
| 9     | Docs + landing site sync to v1.5                                            | pending |
| 10    | Backfill GitHub releases v1.4.7..v1.4.13 from CHANGELOG                    | pending |
| 11    | Final summary `docs/audit/v15-summary.md` with Marc-Brief                  | pending |

Stop conditions: production red, large un-spec'd issue, context cutoff,
or budget short of polish — write status doc, do not auto-rollback.

Time-runs-short minimum to ship v1.5.0: Phase 1 + Phase 2 + Phase 7 +
Phase 8. Phases 3–6 + 9 are deferrable to v1.5.1.

Spec: `/Users/marc/infra/prompts/v15-night-marathon.md` (orchestrator
prompt, every phase, every gate).
