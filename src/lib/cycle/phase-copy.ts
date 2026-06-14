/**
 * v1.15.1 — per-phase education copy → i18n leaf mapping.
 *
 * The `PhaseEducationCard` renders a short, factual "what's happening" line for
 * the active cycle phase. The copy is curated, descriptive-only (no clinical
 * advice, no medical claims) and lives entirely under `cycle.phaseEducation.*`
 * in the message bundles — this module only maps a phase to its leaf key so the
 * i18n-call-site-coverage guard sees the literal `t()` arguments at the call
 * site and the copy stays translatable across all six locales.
 */
import type { CyclePhase } from "@/lib/cycle/types";

/**
 * The phase → i18n leaf for the "what's happening now" descriptive line. The
 * keys are spelled out as string literals (not interpolated) so the
 * call-site-coverage walker resolves each one against `messages/en.json`.
 */
export const PHASE_WHATS_HAPPENING_KEY: Record<CyclePhase, string> = {
  MENSTRUAL: "cycle.phaseEducation.whatsHappening.MENSTRUAL",
  FOLLICULAR: "cycle.phaseEducation.whatsHappening.FOLLICULAR",
  OVULATORY: "cycle.phaseEducation.whatsHappening.OVULATORY",
  LUTEAL: "cycle.phaseEducation.whatsHappening.LUTEAL",
};

/**
 * The phase → i18n leaf for the second, deeper "context" line — what someone
 * might notice (energy, sleep, basal temperature, mood) and a gentle framing of
 * normal variation. Same descriptive-only constraint as above: no advice, no
 * clinical claim, never prescriptive. Spelled out as literals for the same
 * call-site-coverage reason.
 */
export const PHASE_CONTEXT_KEY: Record<CyclePhase, string> = {
  MENSTRUAL: "cycle.phaseEducation.context.MENSTRUAL",
  FOLLICULAR: "cycle.phaseEducation.context.FOLLICULAR",
  OVULATORY: "cycle.phaseEducation.context.OVULATORY",
  LUTEAL: "cycle.phaseEducation.context.LUTEAL",
};
