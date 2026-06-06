/**
 * v1.15.0 — cycle-phase hue tokens.
 *
 * Each phase maps to a dedicated, per-theme CSS custom property defined in
 * `globals.css` (Dracula dark + Alucard light), so the hue is hand-tuned for
 * contrast in both themes — exactly the wellness-ring pattern. The phase
 * semantic is never colour-only: every surface that uses a hue also renders
 * the phase word + an aria-label.
 */
import type { CyclePhase } from "./types";

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
