/**
 * v1.15.0 — cycle-phase hue tokens.
 *
 * Each phase maps to a dedicated, per-theme CSS custom property defined in
 * `globals.css` (Dracula dark + Alucard light), so the hue is hand-tuned for
 * contrast in both themes — exactly the wellness-ring pattern. The phase
 * semantic is never colour-only: every surface that uses a hue also renders
 * the phase word + an aria-label.
 */
import type { CyclePhase, FlowLevel } from "./types";

export const PHASE_HUE: Record<CyclePhase, string> = {
  MENSTRUAL: "var(--cycle-phase-menstrual)",
  FOLLICULAR: "var(--cycle-phase-follicular)",
  OVULATORY: "var(--cycle-phase-ovulatory)",
  LUTEAL: "var(--cycle-phase-luteal)",
};

/** Flow-intensity tint for the calendar period dots (rose family). */
export const FLOW_HUE = "var(--cycle-phase-menstrual)";
/** Fertile-window tint (follicular green family). */
export const FERTILE_HUE = "var(--cycle-phase-follicular)";
/** Ovulation marker tint (amber-gold family). */
export const OVULATION_HUE = "var(--cycle-phase-ovulatory)";

/**
 * Flow-intensity shading — a SINGLE-HUE OPACITY LADDER on the menstrual rose
 * (`FLOW_HUE`), never a rainbow of hues. Heavier flow = a denser fill of the
 * same colour, so the calendar reads as one calm field that deepens with
 * intensity. The ladder is the alpha applied to the period cell's filled pip;
 * every step keeps the day number (foreground, z-10) above it at WCAG AA. The
 * marker is never colour-only — each period day still restates its flow level
 * in the cell aria-label + carries a `data-flow-level` attribute for e2e.
 *
 * SPOTTING (lightest) → HEAVY (densest). NONE keeps no fill (not a period day).
 */
export const FLOW_OPACITY: Record<Exclude<FlowLevel, "NONE">, number> = {
  SPOTTING: 0.14,
  LIGHT: 0.26,
  MEDIUM: 0.42,
  HEAVY: 0.62,
};

/** The default period-day fill alpha when a logged day carries no flow grade. */
export const FLOW_OPACITY_DEFAULT = 0.32;

/** Resolve the flow-shading alpha for a logged period day (graceful fallback). */
export function flowOpacity(flow: string | null | undefined): number {
  if (flow && flow !== "NONE" && flow in FLOW_OPACITY) {
    return FLOW_OPACITY[flow as Exclude<FlowLevel, "NONE">];
  }
  return FLOW_OPACITY_DEFAULT;
}
