# Phase 0 — v1.4.18 bootstrap report

Timestamp: 2026-05-10T10:02+02:00
Branch: `main`
Tracked-files baseline: clean (untracked-only working tree on entry).

## What landed

- `.planning/STATE.md` rewritten for v1.4.18: `Status: phase-0-done`,
  Phase 0 marked complete, Wave A (A1 BD-Zielbereich tile sub-values,
  A2 `/admin/api-tokens` 3rd-attempt scrollbar, A3 chart visual revert
  - per-chart toggles), Wave B (B1 achievements expansion with
    research + hidden Easter-eggs + lock filter), Wave D multi-agent QA
  - Product-Lead, Phase E release. v1.4.17 hotfix and v1.4.16 release
    blocks archived inline above.
- `.planning/ROADMAP.md` rewritten with the v1.4.18 one-liner table
  for Phase 0 / A1-A3 / B1 / D / E. v1.4.17 hotfix line + the full
  v1.4.16 / v1.4.15 / v1.4.14 archive tables retained beneath.
- `.planning/phase-0-report.md` (this file).

## What did NOT land in this commit

Source files. Phase 0 is planning-only per the brief.

## Working tree on entry

Branch was already in sync with `origin/main` after v1.4.17 release
commits. Untracked items left in place (same call as v1.4.16 Phase 0):

- `.planning/phase-E1-report.md`, `phase-E2-report.md`,
  `phase-E3-report.md` — v1.4.16 release reports, belong to that
  milestone.
- `src/app/api/export/{full-backup.json,measurements.csv,
medications.csv,mood.csv}/` — stale dotted-segment route directories;
  the live plain-segment routes shipped in B7 of v1.4.16 (per
  `phase-E1-report.md`).

## Marc's v1.4.18 input

Four items reported by Marc, all reflected as scaffolded checklists:

1. BD-Zielbereich tile shows "7T: —" / "30T: —" with real data behind
   it — investigate root cause and fix the sub-value aggregation.
2. `/admin/api-tokens` table still scrolls horizontally on mobile (3rd
   attempt — earlier column-hide passes addressed table-level overflow
   but page-level overflow may be the real source). Live verify with
   Playwright headless against prod using Marc's session cookie before
   touching code.
3. Chart visual rollback — drop the v1.4.16 B1a gradient fill, drop
   the mood-chart emoji glyphs, drop the auto-overlay personal-baseline
   line. Replace with three opt-in toggles per chart (showTrendIndicator
   / showTargetRange / showPersonalBaseline). Default OFF. Persist
   per-user per-chart. Keep smooth interpolation, rich tooltip,
   animation-on-render.
4. Achievements expansion with proper research first (Apple Health,
   Withings, Oura benchmarking lens). 15-25 new achievements, 5-8
   hidden Easter-eggs (playful, not health-coercive). Lock filter
   hides metrics user has no data for; hidden achievements appear as
   "Hidden" cards (the user knows there's something to find).

## Constraints honoured

- English everywhere, Marc's voice.
- No "Claude / AI / agent / marathon / phase" leaked into the commit
  body.
- Co-Author Claude Opus 4.7 trailer present.
- No `--no-verify`, no `--no-gpg-sign`.
- Single chore commit: `chore(planning): bootstrap v1.4.18 marathon`.
- No source files touched.

## Next

Wave A (A1 + A2 + A3) parallel-bucket dispatch is the obvious next
step; A3's chart revert is the user-visible one Marc will notice
first. A2 wants live Playwright reproduction before any code edit.
B1 starts with a research-first pass per Marc's standing rule on
complex features — no implementation until the research doc lands.
