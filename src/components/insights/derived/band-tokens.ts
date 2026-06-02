/**
 * v1.10.0 — shared score-band token vocabulary for the derived-metrics
 * design system. Extracted so the new primitives (score-ring,
 * coverage-meter, sparkline-delta-tile, provenance-explainer) paint the
 * exact same band colour grammar the shipped `health-score-card` already
 * uses, without each component redeclaring the map (concept cohesion).
 *
 * No new tokens — these point at the existing `--dracula-*` variables in
 * `globals.css`. A green/yellow/red band is the one semantic the whole
 * v1.10 score language extends.
 */

export type ScoreBand = "green" | "yellow" | "red";

/** Tailwind text-colour class per band (the headline number colour). */
export const BAND_NUMBER_CLASS: Record<ScoreBand, string> = {
  green: "text-dracula-green",
  yellow: "text-dracula-orange",
  red: "text-dracula-red",
};

/** Tailwind background class per band (progress/fill bars). */
export const BAND_PROGRESS_CLASS: Record<ScoreBand, string> = {
  green: "bg-dracula-green",
  yellow: "bg-dracula-orange",
  red: "bg-dracula-red",
};

/** Tailwind border-colour class per band (card / chip outlines). */
export const BAND_BORDER_CLASS: Record<ScoreBand, string> = {
  green: "border-dracula-green/40",
  yellow: "border-dracula-orange/40",
  red: "border-dracula-red/40",
};

/**
 * The raw CSS variable per band — used where a Recharts `fill` needs an
 * actual colour string rather than a Tailwind class (the score ring's
 * `<RadialBar fill>`). Reads the same `--dracula-*` tokens so dark and
 * Alucard light modes track automatically.
 */
export const BAND_VAR: Record<ScoreBand, string> = {
  green: "var(--dracula-green)",
  yellow: "var(--dracula-orange)",
  red: "var(--dracula-red)",
};

/**
 * Map a 0..100 score to its band. Mirrors the thresholds the existing
 * health-score blend uses (≥ 70 green, ≥ 40 yellow, else red) so a
 * derived score and the composite health score never disagree on colour
 * for the same number.
 */
export function bandForScore(score: number): ScoreBand {
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

/** Clamp a score into the 0..100 rendering range, defending bad input. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
