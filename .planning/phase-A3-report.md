# Phase A3 — Quick-add labels + Stimmung-Card mobile + onboarding flicker

Status: done · Commits: 3 (3e45a7b, 2c227fb, bb4dc12) · 2026-05-09

## Fix 1 — Quick-Add submenu disambiguation (3e45a7b)

The dashboard "Add" dropdown rendered two items whose visible text both
read as bare nouns ("Messung" / "Stimmungseintrag" in DE; "Measurement" /
"Mood entry" in EN). With the trigger ALSO labelled "Add" / "Hinzufügen"
and the leading icon `aria-hidden`, screen-reader users heard the same
verb 3× with no signal which row did what. Updated both translations to
self-contained verb phrases: DE "Messung erfassen" / "Stimmung erfassen",
EN "Log measurement" / "Log mood". Added
`src/app/__tests__/quick-add-labels.test.ts` to lock the contract:
both labels must be non-empty, distinct from each other, and distinct
from `common.add` (the trigger).

## Fix 2 — Mood-list mobile redundancy (2c227fb)

`src/components/mood/mood-list.tsx` mobile branch (`md:hidden`) rendered
each entry's score TWICE: large bold digit in the left badge, then again
in the title line as `"{score} ({label})"`. Desktop's table only ever
showed it once. Collapsed the title line to just the localized label
(e.g. "Schlecht"); row now reads "[2] Schlecht / 12.05.2026 18:30 / tags".
Added `data-testid="mood-row"` + `data-testid="mood-row-score"` hooks
and a Pixel-5 Playwright spec at `e2e/mood-card-mobile.spec.ts` that
asserts each row contains its score digit exactly once via word-boundary
regex and that the badge still paints the digit.

## Fix 3 — Onboarding flicker + collapsed-by-default (bb4dc12)

Two bugs in one card. Flicker: the component rendered against
default-true `shouldShowChecklist({ measurementCount, ... })` while
analytics was in flight (`measurementCount = 0` until tanstack-query
wrote `data`). For a complete-onboarding user with 30 measurements the
card flashed ~500 ms before `stillInSetup` flipped to false. Fix: refuse
to render until `analyticsQuery.data !== undefined` — tanstack-query
writes `data` exactly once per fetch, race-free.

Auto-open: introduced `expanded` state (default `false`, persisted to
`localStorage[healthlog-getting-started-expanded]`). Header is now a
chevron toggle (`aria-expanded`/`aria-controls`); the progress meter
stays visible in both states. Card mounts collapsed for new users.

E2E spec at `e2e/onboarding-flicker.spec.ts` covers both: a 50ms-sample
loop during a deliberately-slowed analytics fetch proves the card never
paints for a complete-onboarding user, and a second test mounts an
incomplete user and asserts `aria-expanded=false` + that
`#getting-started-body` is NOT in the DOM until clicked.

## Verification

- `pnpm test`: 779 tests / 103 files / all green
- `pnpm typecheck`: clean (0 errors)
- `pnpm lint`: 12 pre-existing warnings, 0 errors
- 3 atomic commits pushed to `origin/main` after rebase-with-autostash;
  no force-pushes, no `--no-verify`, signed via gpg

## Overlap with other agents

A4 added `MedicationComplianceChart` to `src/app/page.tsx` between fix 1
and fix 3 — no collision, my edits to that file were isolated to the
quick-add-menu region. A2 staged `.planning/phase-A1-report.md` +
`.planning/STATE.md` into my staging area mid-commit; I unstaged them
before committing fix 3 so each agent owns their own report file.

## Out of scope (for later phases)

The mood-list mobile fix targets `/mood` (the page where Marc sees the
Stimmung-Card). If "Stimmung-Card mobile redundancy" was intended to
mean the dashboard's mood `TrendCard` instead, that tile already shows
a single number ("2") + unit ("/ 5") with no label text — no changes
needed there.
