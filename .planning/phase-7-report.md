# Phase 7 — Pre-release verification

**Verification agent**: Opus 4.7 (1M context)
**Date**: 2026-05-09 overnight (autonomous mode)
**Node**: v25.9.0 (local) — Node 22 used in CI Docker image (canonical)

## Step-by-step results

| Step                    | Result | Notes                                                                              |
| ----------------------- | ------ | ---------------------------------------------------------------------------------- |
| `pnpm typecheck`        | PASS   | 0 errors                                                                           |
| `pnpm lint`             | PASS   | 0 errors / 12 pre-existing warnings (unused `_request`/`_params`, none introduced) |
| `pnpm format:check`     | PASS\* | Only `src/components/charts/__tests__/trend-card.test.tsx` flagged — see below     |
| `pnpm test`             | PASS   | 97 files / 754 tests green                                                         |
| `pnpm test:integration` | PASS   | 5 files / 11 tests — flake fixed, 10 consecutive runs all green                    |
| `pnpm build`            | FAIL\* | Node-25 `Reflect.get` private-member bug on `/api/version` prerender — documented  |
| `pnpm e2e`              | DEFER  | Web-server step blocked by build failure; same Node-25 bug also hits `next dev`    |

\*Pre-existing or environmental — see below.

## Fixes committed this phase

### `fix(tests): share next/headers cookieJar across integration suite`

The integration suite ran with `vitest isolate: false` (one worker, one
container — the migration cost demands it). `idempotency-replay.test.ts`
declared a top-level `vi.mock("next/headers", ...)` whose factory closed
over a per-file `cookieJar` Map. `admin-data-wipe.test.ts` and
`auth-flow.test.ts` did the same with their own per-file Maps. Vitest
resolves a mock factory ONCE per worker — whichever file loaded first
won the registration, and the other files' writes silently disappeared.

That made `admin-data-wipe.test.ts` flake intermittently when
`idempotency-replay.test.ts` happened to load first (its
`vi.mock("@/lib/auth/session", ...)` then leaked, returning a stub user
without an admin role → `requireAdmin()` 401 → assertion failed).

Empirical flake rate before fix: ~12.5% (1/8 runs). After fix: 0/10.

**Fix**: `tests/integration/mock-next-headers.ts` exports module-singleton
`cookieJar` + `headerJar` Maps. All three integration test files now
share them by `await import("./mock-next-headers")` from inside the
`vi.mock` factory body. The `vi.mock("@/lib/auth/session", ...)` stub
in `idempotency-replay.test.ts` was removed in favour of seeding a real
`Session` row via the cookieJar — same pattern the other two files use.

### Format sweep on planning + docs (no code changes)

`pnpm prettier --write` applied to `.planning/*.md`, `docs/audit/v1414-*.md`,
and `e2e/measurement-flow.spec.ts` to clear the `format:check` warnings
the Phase 6 reconcile-report flagged as pre-existing-out-of-scope.

## Known caveats (NOT regressions, deliberately not fixed)

1. **`pnpm build` Node-25 bug** — `TypeError: Cannot read private member
#state from an object whose class did not declare it` at
   `Reflect.get` inside Turbopack's compiled chunk during
   `/api/version` prerender. Documented at the v1.5 phase-4b report.
   CI Docker uses Node 22 and is canonical; image digest still rolls
   on tag push. **Verified the same bug also affects `next dev`** on
   Node 25, so e2e cannot run locally either; it'll run green in CI
   on Node 22 (Phase-3 report records 41/41 specs green there).

2. **`src/components/charts/__tests__/trend-card.test.tsx` Prettier
   warning** — single test file flagged for line-collapse formatting
   (`<TrendCard ... />` JSX). Marc constraint forbids touching
   `src/components/charts/**`. Pre-existing per Phase 6 reconcile.
   Pure formatting, zero behavioural impact.

3. **Phase 4b open-state inheritance** — neither `pnpm test:integration`
   nor `pnpm e2e` was executed after Phase 6 reconcile (Phase 6's
   final-verify ran `typecheck/lint/test/format` only). The integration
   flake fixed here had been latent since v1.4 and surfaced now because
   `admin-data-wipe.test.ts` (added in commit `512a6a6`, Phase 2) loaded
   the right modules in the right order to expose it.

## Acceptance-criterion tally

- [x] typecheck clean
- [x] lint 0 errors
- [x] format:check clean (modulo the one chart-test file blocked by Marc constraint)
- [x] vitest fully green
- [x] integration tests fully green (flake fixed)
- [-] build — Node-25 caveat documented; CI Docker (Node 22) is canonical
- [-] e2e — same Node-25 caveat applies; CI runs the suite on Node 22

Phase 8 (release) can proceed: typecheck/lint/test/integration are
canonical signal locally, and CI exercises build + e2e on Node 22.
