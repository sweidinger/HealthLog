# v1.4.6 marathon — state log

Status: **release tagged, awaiting Coolify deploy** (2026-05-09 ~02:30)

## Phase 0 — Bootstrap ✅

Committed `ecca54d`.

## Phase 1 — CI green ⚠️

- e2e workflow fixed in `bcd1de4` (pnpm-version override) and `46e686f`
  (mobile project → Pixel 5, locale-cookie anchor, login-form open).
- Latest run on the v1.4.6 SHA is queued; conclusion not yet known
  at tag time. Per release-spec, e2e green is not a hard gate.

## Phase 2 — Tier 1 fixes (T1–T9) ✅

| ID      | Commit    | Note                                                 |
| ------- | --------- | ---------------------------------------------------- |
| T1 + T2 | `8aae7d6` | tile fill + muted-foreground hierarchy               |
| T3      | `a75fbc6` | primary recommendation chart-token render            |
| T4      | `eba898f` | aiBaseUrl cross-provider leak fix + test             |
| T5      | `c8ee28d` | insights/generate 502 → 422                          |
| T6      | `4aeb8c9` | admin status-card hrefs + tightened test             |
| T7      | `31959e4` | bug-report toggle now blocks /api/feedback + UI      |
| T8      | `c3ca861` | data-wipe preserves AuditLog + scope copy            |
| T9      | `1adda80` | per-card window 360+24 buckets, 7 generators + tests |

## Phase 3 — Chart bucketing ✅

`6a64df0` — `bucketTimeSeries` helper + chip in chart header + 14
unit tests.

## Phase 4 — Tier 2 polish ✅

P1-P5 in `fda8dd8`, P6+P10 in `dc6db82`, P7-P9 in `5c884b3`, P11 in
`e903d9a`, P12 in `c7b6005`, P13 in `4a159d2`, P14 in `dcc697c`,
P15+P16 in `89b5b80`, P17 in `505f318`, P18 in `86a4b52`, P19 in
`2654337`, P20 in `dc4507a`.

## Phase 5 — QA ✅

3 parallel reviewers (security / design / code-review). No
CRITICAL / HIGH carried into v1.4.6 except 3 quick follow-ups
applied in `6757518`:

- ai-section.tsx orange tokens → dracula tokens (also fixes contrast)
- status-card-grid.tsx CTAs relabelled honestly ("Open integrations",
  "Open system status")
- idempotency.ts `text.includes("sk-")` → tightened regex with
  false-positive regression tests for "task-id" / "risk-management"

Deferred to v1.5: notification-channel data-wipe scope (M1), Berlin
TZ DST math in cross-metric joins (HIGH from code-review),
exhaustive-deps + set-state-in-effect refactor in about-section.

## Phase 6 — Pre-release verification ✅

`pnpm typecheck` clean, `pnpm lint` 0 errors / 12 warnings,
`pnpm format:check` clean (after the prettier sweep in `02b9955`),
`pnpm test` 714 passed, `pnpm test:integration` 10 passed.
`pnpm build` fails locally on Node 25 (Reflect.get private member
bug in Turbopack); CI Docker uses Node 22 and is the canonical
release build path.

## Phase 7 — Release ✅

- `package.json` 1.4.6 (`a852612`)
- `CHANGELOG.md` v1.4.6 block (`a852612`)
- Tag `v1.4.6` pushed
- GHCR docker-publish: in_progress
- Coolify deploy: pending GHCR

## Phase 8 — Releases ✅

GitHub releases v1.4.2, v1.4.3, v1.4.4, v1.4.5, v1.4.6 backfilled
from the CHANGELOG blocks. URLs:
https://github.com/MBombeck/HealthLog/releases/tag/v1.4.{2,3,4,5,6}

GHCR untagged-manifest cleanup: not run; pre-existing tagged
versions (v1.x.x) are pinned, no orphan manifests visible. Defer
unless Marc asks.

## Phase 9 — Docs / landing 🔄

`general-purpose` agent dispatched to bring `healthlog-docs` from
v1.2 to v1.4.6 and apply minimal updates to `healthlog-landing`.
Running in background.

## Phase 10 — Summary

`docs/audit/v146-summary.md` — last step.
