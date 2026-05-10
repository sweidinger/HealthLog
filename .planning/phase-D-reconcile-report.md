# v1.4.19 Phase D — Reconcile Report

Date: 2026-05-09
Agent: Phase D RECONCILE

## CRITICAL — fixed

- **C-01** (code-review) — `MeasurementList` mobile branch checked
  `m.type === "BP_SYS" / "BP_DIA"`; canonical enum values are
  `BLOOD_PRESSURE_SYS / BLOOD_PRESSURE_DIA`. Badge never painted on
  mobile. Routed through `MEASUREMENT_TYPE_LABEL_KEYS[m.type]` so the
  mobile branch shares the desktop table's single source of truth.
  TDD red→green guard renders both rows in EN + DE and asserts each
  Sys / Dia badge appears twice (one per branch).
  **Commit `ef74241`**.

## HIGH triage

| ID | Source | Decision | Commit / Backlog ref |
|---|---|---|---|
| H-01 (code) | UTC clock breaks Berlin convention | **fixed** | `1258b24` |
| H-02 (code) | useViewportWidth setState in effect | **fixed** | `5a8ad3d` |
| H-03 (code) | Orphan icon wrapper after card-title removal | **fixed via simplify F4** | `6b35cad` |
| H-04 (code) | Tabs ring clip on focus-visible | **fixed** | `977f124` |
| H-05 (code) | `/insights` `data?.` post-narrowing | deferred (D-CR-H-05) | v1.4.20 backlog |
| H-01 (design) | api-tokens truncate-tooltip on touch | deferred (D-DSGN-H-01) | v1.4.20 backlog |
| H-02 (design) | Insights hero density on Pixel-5 | deferred (D-DSGN-H-02) | folded into v1.4.20 redesign |
| H-1 (senior-dev) | DateInput wrapper | **fixed via simplify F3** | `6b35cad` |
| H-2 (senior-dev) | useAuthActionLabels lift-out | **fixed via simplify F1** | `6b35cad` |
| H-3 (senior-dev) | Withings/MoodLog card chrome | deferred (D-SR-H-3) | v1.4.20 backlog |

Tally: **7 HIGH fixed, 3 HIGH deferred**.

## Simplify-yes — applied

All 5 simplify-yes findings landed in one combined commit (`6b35cad`):

- F1 — `useAuthActionLabels()` hook in `_shared.tsx`; both consumers
  call it (also resolves senior-dev H-2 + M-3).
- F2 — drop dead `chipClass = ""` branches in `IntegrationStatusPill`.
- F3 — new `<DateInput>` / `<DateTimeInput>` wrappers; 14 callsites
  converted across 9 files (also resolves senior-dev H-1).
- F4 — drop the leading icon-only flex wrappers on
  `feedback-inbox-section`, `danger-zone-section`,
  `thresholds-editor-section` (also resolves code-review H-03).
- F8 — strip the five "v1.4.19 X removed because…" narration
  comments from `insights/page.tsx` and the dashboard.

No reverts. Scoped tests green throughout (155/155 across
`measurements`, `medications`, `mood`, `settings`, `admin`,
`doctor-report`).

## Final verification

- `pnpm typecheck` — clean.
- `pnpm lint` — 0 errors, 12 baseline warnings (no new warnings).
- `pnpm format:check` — pre-existing `.planning/*` + `docs/audit/*`
  baseline only.
- `pnpm test --run` — see Final-tally section below.
- `pnpm test:integration` — see Final-tally section below.

## Pointers

- v1.4.20 backlog: `.planning/v1420-backlog.md` — new "Phase D — v1.4.19
  reconcile carry-over" block lists the 3 HIGH + 16 MED + LOW deferrals
  with file:line references.
- v1.5 backlog: `.planning/v15-backlog.md` — strategic items pulled from
  the Product-Lead review (conversation persistence, correlation FDR,
  Apple Health absence, streaming UX, prompt injection, safeParse audit
  pattern, cross-user feedback aggregation, Coolify auto-deploy, ARM
  runner, worktree mandate).
- Product Lead: `.planning/phase-D-v1419-product-lead-review.md` —
  v1.4.20 redesign plan + risk watchlist (untouched in this reconcile).
