/**
 * Absolute clinical safety floors (v1.18.6) — confirm-before-alarm engine.
 *
 * The illness *correlation* engine (`correlation.ts`) is retrospective: it
 * flags a SUSTAINED multi-day adverse run against a user's OWN baseline. This
 * module is its safety-critical complement: it evaluates a SINGLE freshly
 * logged reading against ABSOLUTE, guideline-backed clinical floors and, when
 * a reading breaches one, decides whether to escalate — but ONLY after a
 * second, confirming reading (the AHA "wait and re-measure" discipline), so a
 * single oscillometric spike or a one-off finger-stick can never raise a
 * false alarm.
 *
 * Hard design rules (this is health-safety code — conservative by construction):
 *
 *   1. CONFIRM BEFORE ALARM. A breach reading alone is NEVER enough. We
 *      require a PRIOR reading of the same kind inside a short re-test window
 *      that ALSO breached the same floor. One reading → "watch", two → alarm.
 *      (Severe-tier floors keep the same confirm gate — the differentiator
 *      between tiers is the copy, not whether we wait.)
 *   2. NEVER DIAGNOSE. The copy says "this reading is very high/low — re-check
 *      and, if it holds, contact your doctor / call emergency services". It
 *      never names a condition (no "hypertensive emergency", no "DKA").
 *   3. SYMPTOM-COUPLED → emergency copy; ASYMPTOMATIC → contact-doctor copy.
 *      The caller passes whether the user flagged symptoms with the reading.
 *   4. MODULE-GATED. The caller only runs the relevant check when the module
 *      is enabled (glucose module for glucose, the always-on BP core for BP).
 *
 * Pure given its inputs — no Prisma, no I/O. The caller resolves the recent
 * same-kind readings + the symptom flag and passes them in; the dispatch +
 * 24h dedup lives in `safety-floor-notify.ts`. mg/dL + mmHg throughout
 * (HealthLog canonical store units).
 *
 * Citations (general guidance, not medical advice; wide individual variation):
 *   - BP ≥180/120: ACC/AHA 2017; AHA "Management of Elevated BP in the Acute
 *     Care Setting" 2024. The number is identical for emergency vs non-
 *     emergency — symptoms are the differentiator, not the value. Protocol:
 *     re-measure before acting.
 *   - Low BP (SBP < 90): NHLBI low-blood-pressure guidance; Hypotension —
 *     StatPearls/NIH 2024. Cautionary by default; emergency only with self-
 *     reported shock-type symptoms.
 *   - Hypoglycemia: ADA Standards of Care §6 — Level 1 alert < 70 mg/dL,
 *     Level 2 (clinically significant) < 54 mg/dL. Stable 2024–2026.
 *   - Hyperglycemia / DKA: ADA Standards of Care 2026 — DKA hyperglycemia
 *     criterion lowered to ≥ 200 mg/dL; ~10% of DKA is euglycemic, so a
 *     glucose value alone cannot rule it out — we NEVER show "all clear" below
 *     200 and reserve the urgent escalation for a sustained very-high band
 *     (≥ 250 mg/dL) per the practical seek-care trigger.
 */

/** Reading kinds the absolute-floor engine evaluates. */
export type SafetyFloorKind = "BLOOD_PRESSURE" | "GLUCOSE";

/** Why a reading breached a floor — a stable key the i18n layer renders. */
export type SafetyFloorReason =
  | "bp_hypertensive" // SBP ≥ 180 OR DBP ≥ 120
  | "bp_hypotensive" // SBP < 90
  | "glucose_hypo" // < 70 mg/dL
  | "glucose_hypo_severe" // < 54 mg/dL
  | "glucose_hyper"; // ≥ 250 mg/dL (sustained-very-high seek-care trigger)

/** Severity tier — drives copy, never the confirm gate. */
export type SafetyFloorTier = "caution" | "severe";

/* ── absolute floors (canonical, imported from the one source of truth) ── */

// D3-H1: the numeric floors now live in `@/lib/clinical-floors` so the hero
// (`verdict.ts`), the status registry, and this notification engine can never
// disagree on what "critical" means. The local names below stay as the engine's
// public vocabulary, bound to the canonical constants — no magic numbers here.
import {
  BP_SYS_CRITICAL,
  BP_DIA_CRITICAL,
  BP_SYS_HYPOTENSIVE_FLOOR,
  GLUCOSE_HYPO_FLOOR,
  GLUCOSE_HYPO_SEVERE_FLOOR,
  GLUCOSE_HYPER_FLOOR,
} from "@/lib/clinical-floors";

/** Hypertensive-urgency floor: systolic ≥ this OR diastolic ≥ DIA floor. */
export const BP_SYS_HYPERTENSIVE = BP_SYS_CRITICAL;
export const BP_DIA_HYPERTENSIVE = BP_DIA_CRITICAL;
/** Symmetric low-BP cautionary floor: systolic < this. */
export const BP_SYS_HYPOTENSIVE = BP_SYS_HYPOTENSIVE_FLOOR;

/** Hypoglycemia Level-1 alert: glucose < this (mg/dL). */
export const GLUCOSE_HYPO = GLUCOSE_HYPO_FLOOR;
/** Hypoglycemia Level-2 (clinically significant): glucose < this (mg/dL). */
export const GLUCOSE_HYPO_SEVERE = GLUCOSE_HYPO_SEVERE_FLOOR;
/**
 * Hyperglycemia urgent escalation floor (mg/dL). ADA 2026 lowered the DKA
 * hyperglycemia CRITERION to ≥ 200, but a value alone cannot rule DKA in OR
 * out (euglycemic DKA exists), so we do NOT urgently escalate at 200. We
 * reserve the escalation for the practical "sustained very-high" seek-care
 * trigger (≥ 250) and the copy NEVER reads "all clear" below 200.
 */
export const GLUCOSE_HYPER = GLUCOSE_HYPER_FLOOR;

/**
 * Confirm window: a breach reading only escalates when a PRIOR same-kind
 * reading inside this window ALSO breached the SAME floor. Long enough that a
 * deliberate "wait a minute and re-measure" is captured, short enough that two
 * unrelated readings days apart don't spuriously confirm each other.
 */
export const CONFIRM_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/* ── inputs (the caller resolves these and passes them in) ───────────── */

/** A blood-pressure reading (systolic + diastolic, mmHg) at an instant. */
export interface BpSample {
  measuredAt: Date;
  systolic: number;
  diastolic: number;
}

/** A spot glucose reading (mg/dL canonical) at an instant. */
export interface GlucoseSample {
  measuredAt: Date;
  mgdl: number;
}

/** The escalation decision the engine returns (or null = nothing to do). */
export interface SafetyFloorDecision {
  kind: SafetyFloorKind;
  reason: SafetyFloorReason;
  tier: SafetyFloorTier;
  /** True when the user flagged symptoms → emergency-tier copy. */
  symptomCoupled: boolean;
  /** The breaching value(s), for the localised body params. */
  value: number;
  /** The diastolic value when `kind === "BLOOD_PRESSURE"` (else null). */
  diastolic: number | null;
}

/* ── BP evaluation ────────────────────────────────────────────────────── */

/** Classify a single BP reading against the absolute floors. */
function classifyBp(
  sys: number,
  dia: number,
): { reason: SafetyFloorReason; tier: SafetyFloorTier } | null {
  if (sys >= BP_SYS_HYPERTENSIVE || dia >= BP_DIA_HYPERTENSIVE) {
    return { reason: "bp_hypertensive", tier: "severe" };
  }
  if (sys < BP_SYS_HYPOTENSIVE) {
    // Symmetric low-BP is cautionary by default — most hypotension is benign;
    // it only becomes urgent when symptom-coupled (handled by the caller's
    // symptom flag, which lifts the copy to emergency tier).
    return { reason: "bp_hypotensive", tier: "caution" };
  }
  return null;
}

/**
 * Evaluate a fresh BP reading against the absolute floors with the confirm
 * gate. Returns a decision ONLY when the candidate breaches AND a prior
 * reading inside the confirm window breached the SAME reason. `recent` is the
 * user's other same-kind readings (excluding the candidate); order-independent.
 */
export function evaluateBloodPressure(input: {
  candidate: BpSample;
  recent: BpSample[];
  symptomCoupled: boolean;
}): SafetyFloorDecision | null {
  const { candidate, recent, symptomCoupled } = input;
  const candClass = classifyBp(candidate.systolic, candidate.diastolic);
  if (!candClass) return null;

  const windowStart = candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS;
  const confirmed = recent.some((r) => {
    const t = r.measuredAt.getTime();
    if (t < windowStart || t > candidate.measuredAt.getTime()) return false;
    const c = classifyBp(r.systolic, r.diastolic);
    return c?.reason === candClass.reason;
  });
  if (!confirmed) return null;

  return {
    kind: "BLOOD_PRESSURE",
    reason: candClass.reason,
    // A symptom-coupled hypotensive breach escalates to severe-tier copy
    // (shock signs → emergency); asymptomatic stays cautionary.
    tier:
      candClass.reason === "bp_hypotensive" && symptomCoupled
        ? "severe"
        : candClass.tier,
    symptomCoupled,
    value: candidate.systolic,
    diastolic: candidate.diastolic,
  };
}

/* ── glucose evaluation ───────────────────────────────────────────────── */

/** Classify a single glucose reading (mg/dL) against the absolute floors. */
function classifyGlucose(
  mgdl: number,
): { reason: SafetyFloorReason; tier: SafetyFloorTier } | null {
  if (mgdl < GLUCOSE_HYPO_SEVERE) {
    return { reason: "glucose_hypo_severe", tier: "severe" };
  }
  if (mgdl < GLUCOSE_HYPO) {
    return { reason: "glucose_hypo", tier: "caution" };
  }
  if (mgdl >= GLUCOSE_HYPER) {
    return { reason: "glucose_hyper", tier: "severe" };
  }
  return null;
}

/**
 * Evaluate a fresh glucose reading against the absolute floors with the
 * confirm gate. The confirm match is by FLOOR FAMILY, not exact reason: a
 * follow-up reading that is hypo (< 70) confirms a candidate that is
 * severe-hypo (< 54) and vice versa — both are "the low floor held on
 * re-test". The same applies to the high floor. Hypoglycemia is acutely
 * dangerous, so a severe-hypo candidate confirmed by ANY low re-test still
 * escalates at the severe tier (the candidate's own tier wins).
 */
export function evaluateGlucose(input: {
  candidate: GlucoseSample;
  recent: GlucoseSample[];
  symptomCoupled: boolean;
}): SafetyFloorDecision | null {
  const { candidate, recent, symptomCoupled } = input;
  const candClass = classifyGlucose(candidate.mgdl);
  if (!candClass) return null;

  const family = floorFamily(candClass.reason);
  const windowStart = candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS;
  const confirmed = recent.some((r) => {
    const t = r.measuredAt.getTime();
    if (t < windowStart || t > candidate.measuredAt.getTime()) return false;
    const c = classifyGlucose(r.mgdl);
    return c != null && floorFamily(c.reason) === family;
  });
  if (!confirmed) return null;

  return {
    kind: "GLUCOSE",
    reason: candClass.reason,
    tier: candClass.tier,
    symptomCoupled,
    value: Math.round(candidate.mgdl),
    diastolic: null,
  };
}

/** Group a glucose reason into its directional floor family for confirm-matching. */
function floorFamily(reason: SafetyFloorReason): "low" | "high" | "other" {
  if (reason === "glucose_hypo" || reason === "glucose_hypo_severe") {
    return "low";
  }
  if (reason === "glucose_hyper") return "high";
  return "other";
}
