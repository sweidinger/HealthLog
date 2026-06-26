/**
 * Canonical clinical safety floors — ONE source of truth (v1.21.0, D3-H1).
 *
 * Before this module the "is this a crisis?" thresholds were defined in three
 * places with a divergent diastolic floor: the safety-floor notification engine
 * and the Coach acute clause used 180/120, but the dashboard hero's `bpCritical`
 * rung used 180/110 — so a reading like 170/112 lit the red "critical BP" hero
 * banner yet never tripped the notification alarm or the Coach's stated acute
 * number. One surface said crisis, the other two stayed calm on the same row.
 *
 * This leaf holds the absolute, guideline-backed floors as plain constants and
 * every consumer imports from here:
 *   - `src/lib/illness/safety-floors.ts` (the confirm-before-alarm engine),
 *   - `src/lib/dashboard/verdict.ts` (the hero `bpCritical` rung),
 *   - `src/lib/insights/metric-status-registry.ts` (the fever band line),
 *   - and (left to the prompt agent) the `safetyAcute` / `safetyGlp1` Coach
 *     contracts, which must bind their prose numbers to these exports rather
 *     than hardcoding literals — see the comment at each constant.
 *
 * CLIENT-SAFE: dependency-free literals only. `verdict.ts` runs inside the
 * `"use client"` dashboard hero, and its import-graph client-safety test
 * (`verdict-client-safety.test.ts`) walks every VALUE import reachable from
 * `verdict.ts`. Do NOT add any import to this file — no prisma, no `node:`
 * builtins, no server graph. Constants only.
 *
 * Units: mmHg (BP), mg/dL (glucose), °C (temperature) — HealthLog canonical
 * store units throughout.
 *
 * Citations (general guidance, not medical advice; wide individual variation):
 *   - BP ≥ 180/120: ACC/AHA 2017; AHA "Management of Elevated BP in the Acute
 *     Care Setting" 2024. The number is identical for emergency vs non-
 *     emergency — symptoms are the differentiator, not the value. The crisis
 *     DIASTOLIC floor is 120, NOT the old hero 110: 120 is the hypertensive-
 *     urgency standard, so the wider 110 net is dropped to keep the three
 *     surfaces telling one story (D3-H1).
 *   - Low BP (SBP < 90): NHLBI low-blood-pressure guidance; Hypotension —
 *     StatPearls/NIH 2024.
 *   - Hypoglycemia: ADA Standards of Care §6 — Level 1 alert < 70 mg/dL,
 *     Level 2 (clinically significant) < 54 mg/dL.
 *   - Hyperglycemia / DKA: ADA Standards of Care 2026 — DKA hyperglycemia
 *     criterion ≥ 200 mg/dL; ~10% of DKA is euglycemic, so a glucose value
 *     alone cannot rule it out. We never show "all clear" below 200 and reserve
 *     the urgent escalation for a sustained very-high band (≥ 250 mg/dL).
 *   - Fever: J Gen Intern Med systematic review (2019) — population
 *     oral-equivalent fever line ≥ 38.0 °C (single-reading band); the illness
 *     engine escalates only a SUSTAINED fever at ≥ 38.5 °C (multi-day adverse
 *     run). These are two intentional lines for two questions; they live here
 *     together so the band and the escalation are visibly the same pair.
 *   - SpO₂: red-flag floor ≤ 92% (sustained-low escalation).
 */

/* ── blood pressure ─────────────────────────────────────────────────────── */

/** Hypertensive-crisis floor: systolic ≥ this (mmHg). */
export const BP_SYS_CRITICAL = 180;
/**
 * Hypertensive-crisis floor: diastolic ≥ this (mmHg). 120 (ACC/AHA), the
 * single crisis diastolic floor across the hero, the notification engine, and
 * the Coach acute clause (D3-H1 — was 110 on the hero only).
 */
export const BP_DIA_CRITICAL = 120;
/** Symmetric low-BP cautionary floor: systolic < this (mmHg). */
export const BP_SYS_HYPOTENSIVE_FLOOR = 90;

/* ── glucose (mg/dL) ────────────────────────────────────────────────────── */

/** Hypoglycemia Level-1 alert: glucose < this. */
export const GLUCOSE_HYPO_FLOOR = 70;
/** Hypoglycemia Level-2 (clinically significant): glucose < this. */
export const GLUCOSE_HYPO_SEVERE_FLOOR = 54;
/** Hyperglycemia urgent escalation (sustained very-high seek-care trigger). */
export const GLUCOSE_HYPER_FLOOR = 250;

/* ── temperature (°C) ───────────────────────────────────────────────────── */

/** Single-reading fever band line (status cards). */
export const FEVER_BAND_C = 38.0;
/** Sustained-fever escalation floor (illness engine red flag). */
export const FEVER_RED_FLAG_C = 38.5;
/** Sustained-low SpO₂ red-flag floor (%). */
export const SPO2_RED_FLAG_PCT = 92;
