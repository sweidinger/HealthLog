/**
 * Medication compliance calculations.
 *
 * v1.5.0 — `calculateCompliance` is now a cadence-aware adapter on top
 * of `complianceChips` / `buildCadenceTimeline`. Prior to this release
 * the helper computed `totalExpected = schedules.length * days`, which
 * silently ignored `MedicationSchedule.daysOfWeek` and `intervalWeeks`.
 * A weekly Ozempic schedule (Mondays only) reported ~13% adherence
 * instead of 100%; a weekday-only 3×/day metformin reported 73%
 * instead of 100%. The wire shape (`{ totalExpected, taken, skipped,
 * missed, rate, streak }`) is unchanged so every consumer (Health
 * Score, AI Coach prompt context, /api/medications/[id]/compliance,
 * BP-status compliance gate, insight targets, the per-medication
 * tile) keeps reading the same fields. Only the math underneath the
 * fields was wrong — that's what got fixed. Closes #214.
 *
 * `classifyIntakeTiming` is unchanged and still owns the early /
 * on_time / late / very_late punctuality bucket logic used by the
 * daily compliance heatmap on `/api/medications/[id]/compliance`.
 *
 * ---
 *
 * This file is a thin barrel. The implementation lives in focused modules
 * under `./compliance/` — split along the original internal seams so the
 * most-changed business path is editable one concern at a time:
 *
 *   - `compliance/parsing.ts`     HH:mm parsing + punctuality classification
 *   - `compliance/types.ts`       shared shapes, selects, context builders
 *   - `compliance/adapters.ts`    canonical-engine adapters (internal)
 *   - `compliance/dose-status.ts` per-dose window model + cadence family
 *   - `compliance/occurrences.ts` expected-slot expansion + counting
 *   - `compliance/windows.ts`     the compliance-window ladder + selection
 *   - `compliance/cycle.ts`       open-cycle (current dose) descriptor
 *   - `compliance/ledger.ts`      dose-history ledger tally + per-day rates
 *   - `compliance/display.ts`     two-row display, calculateCompliance, bundle
 *
 * Every symbol the eight compliance call sites import keeps resolving from
 * `@/lib/analytics/compliance` — no consumer import path changed.
 */

export * from "./compliance/parsing";
export * from "./compliance/types";
export * from "./compliance/dose-status";
export * from "./compliance/occurrences";
export * from "./compliance/windows";
export * from "./compliance/cycle";
export * from "./compliance/ledger";
export * from "./compliance/display";
