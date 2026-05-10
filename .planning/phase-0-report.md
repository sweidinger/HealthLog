# Phase 0 — v1.4.19 bootstrap report

Timestamp: 2026-05-10T12:48+02:00
Branch: `main`
Tracked-files baseline: clean (untracked-only working tree on entry).

## What landed

- `.planning/STATE.md` rewritten for v1.4.19: `Status: phase-0-done`,
  Phase 0 marked complete, Wave A scaffolded with eight buckets (A1
  BD-Zielbereich constant 50% 4th-attempt root-cause via live-DB audit,
  A2 charts mobile axis-label + X-axis-density audit + universal
  tick-density helper, A3 `/insights` polish + Comparison-toggle
  relocation + placeholder-leak cleanup, A4 AI-prompt rework dropping
  the auto "Datengrundlage stark" first sentence, A5
  Settings/Integrations status-UI consolidation, A6 Settings mobile
  audit + consistency, A7 Admin polish covering Feedback tabs +
  api-tokens 4th attempt + Zielwerte i18n + whitespace, A8 quality-of-
  life write-only audit). Wave B applies A8 findings inline. Wave D
  multi-agent QA + Product-Lead briefed for v1.4.20 Insights-redesign
  roadmap + AI-Coach feasibility. Phase E is the release. v1.4.18,
  v1.4.17 hotfix and v1.4.16 archived inline beneath the active
  scaffold.
- `.planning/ROADMAP.md` rewritten with the v1.4.19 one-liner table
  for Phase 0 / A1-A8 / B / D / E. Reserved-next strategic milestones
  recorded explicitly: v1.4.20 = Insights redesign with AI Coach
  (handoff at `~/Downloads/design_handoff_insights_redesign`), v1.5 =
  iOS app + Apple Health. v1.4.18 archived alongside the existing
  v1.4.17 / v1.4.16 / v1.4.15 / v1.4.14 tables beneath.
- `.planning/phase-0-report.md` (this file).

## What did NOT land in this commit

Source files. Phase 0 is planning-only per the brief.

## Working tree on entry

Branch in sync with `origin/main` after the v1.4.18 release commits
(head `106ef2d docs(audit): v1.4.18 release summary`). Untracked items
left in place (same call as v1.4.16 / v1.4.18 Phase 0):

- `src/app/api/export/{full-backup.json,measurements.csv,
medications.csv,mood.csv}/` — stale dotted-segment route directories;
  the live plain-segment routes shipped in B7 of v1.4.16.

## Marc's v1.4.19 input

Eight buckets Marc reported plus a quality-of-life audit, all
reflected as scaffolded checklists:

1. BD-Zielbereich tile reads exactly 50% across all three windows
   (7T / 30T / total) — looks like a calculation bug, not the
   predicate. Marc granted live-DB access for the root-cause audit.
2. Charts at Pixel-5 viewport: "Wochendurchschnitt" + range tabs
   wrap-break, and X-axis tick density is inconsistent (medication
   chart shows every date, weight/BMI sparser). Universal helper.
3. `/insights` polish: Comparison-toggle move from Dashboard to
   `/insights` (research §4 said next to range tabs), refresh-button
   consolidation, "Persönlicher AI Berater" empty-title fix, drop the
   small BP/Weight tile duplicates, kill the raw `metric:
blood_pressure_sweet` template-leak at the bottom.
4. AI prompt: stop opening every recommendation with "Datengrundlage
   stark"; only mention data quality when low.
5. Settings → Integrations: single status tag top-right per
   integration (Withings + Mood Log), drop the redundant container,
   add the Mood Log divider, mobile-safe wrap.
6. Settings mobile audit: equalize input heights, consistent Sprache
   menu position, right-side action-button alignment, consistent
   spacing across all `/settings/*` pages.
7. Admin polish: Feedback tab spurious mini-scrollbar, api-tokens
   4th-attempt fix via `text-ellipsis` + tooltip on hover (NOT
   column-hide), drop the unnecessary "Einklappen" button, Zielwerte
   whitespace + DE labels for status pills.
8. Quality-of-life write-only audit (A8) — find descriptions
   correctness issues, redundancies, missing labels and UI
   inconsistencies; output prioritized list. Wave B applies the
   CRITICAL/HIGH inline.

## Constraints honoured

- English everywhere, Marc's voice.
- No "Claude / AI / agent / marathon / phase" leaked into the commit
  body.
- Co-Author Claude Opus 4.7 trailer present.
- No `--no-verify`, no `--no-gpg-sign`.
- Single chore commit: `chore(planning): bootstrap v1.4.19 marathon`.
- No source files touched.

## Next

Wave A (A1 + A2 + A3 + A4 + A5 + A6 + A7 + A8) parallel-bucket
dispatch. A1 needs live-DB read against Marc's account before any
code change. A2 + A6 need Playwright headless against prod. A8 is
write-only and feeds Wave B. Product-Lead briefing for Wave D should
include the v1.4.20 Insights-redesign handoff at
`~/Downloads/design_handoff_insights_redesign` so the strategic review
is forward-looking, not just retrospective.
