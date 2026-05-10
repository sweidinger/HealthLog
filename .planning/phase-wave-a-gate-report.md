# Wave-A verification gate — v1.4.16 marathon

Status: green for Wave A; pre-existing CI infra failures unchanged.
Gate-run sha: `94c748d8` (origin/main HEAD when verification started;
Wave B has since advanced to `8d9f864` mid-run).

## CI status (last completed run per workflow on `94c748d`)

| Workflow               | Conclusion | Notes                                                                                     |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| Security & Quality     | success    | typecheck + lint + unit tests all green                                                   |
| Integration tests      | failure    | pre-existing, started 2026-05-09T18:47:14Z (commit `d8c549e`); 50+ runs failing           |
| e2e                    | failure    | pre-existing, see `.github/workflows/e2e.yml`; 25 failures + 74 cancellations in last 100 |
| Build & Publish Docker | cancelled  | superseded by next push — normal during marathon push cadence                             |
| Post-publish verify    | skipped    | gated on Build success                                                                    |

Both failing workflows predate Wave A — `0985c93` (v1.4.15 release) shows
the identical 6-test integration failure shape and an e2e failure at the
same commit. None of Wave-A's 8 commits touched `src/lib/crypto.ts`,
the integration test fixtures, or the Playwright suites that fail.

## Local verification (clean clone of origin/main `94c748d`)

Run inside `/tmp/hl-verify` to bypass parallel-agent worktree pollution:

- `pnpm typecheck`: 0 errors
- `pnpm lint`: 0 errors, 12 pre-existing warnings (matches Wave-A reports)
- `pnpm format:check`: 34 files unformatted — all `.planning/` reports,
  `docs/audit/v1415-summary.md`, and Wave-A/Wave-B-touched test files.
  Pre-existing on origin/main, NOT enforced by any CI workflow.
- `pnpm test --run`: 1153/1153 passing (140 files)
- `pnpm test:integration`: 41/41 passing (12 files) — confirms the
  CI integration failure is environment-specific, not source-level.
  Locally reproduces with the exact CI env vars (`ENCRYPTION_KEY=0…`,
  `API_TOKEN_HMAC_KEY`, `SESSION_SECRET`) and still passes — likely a
  Node-22 vs Node-25 or Linux-vs-macOS difference. Not a Wave-A issue.

## Regressions caught

None attributable to Wave A. The only test that flickered red during
verification was an i18n locale-integrity check, but that was caused by
a parallel Wave-B agent's uncommitted `messages/en.json` keys leaking
into my working tree from a sibling worktree push — not a real
regression. Confirmed clean on a fresh clone.

## Wave-B start signal

**Wave A green, Wave B unblocked.** Wave-B agents are already pushing
(B3, B4, B5a, B5c, B7 commits visible on origin/main) and Marc has
green-lit them via the parallel-agent push cadence.
