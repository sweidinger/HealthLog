/**
 * v1.13.x — per-metric ring hues for the wellness-score strip.
 *
 * The premium-redesign signature is Apple's: a SINGLE-hue, TWO-stop
 * gradient per ring (dark→light tones of the *same* colour), never a
 * multi-hue rainbow. Each metric leans toward an intentional hue (Oura's
 * per-metric move): readiness greener, sleep bluer/indigo, recovery +
 * strain turquoise, stress amber.
 *
 * Every stop rides the SEMANTIC / `--dracula-*` tokens (not raw hex), so
 * the Alucard light-mode overrides (`--success #14720a`, `--info #036a96`,
 * `--warning #a34d14`, `--destructive #cb3a2a`) apply automatically and the
 * arc holds contrast in both themes. The band semantic is never carried by
 * the hue: it still rides `data-band` + the band word + the aria-label, so
 * a red-band readiness still reads "low" in copy while its ring leans green.
 */

import type { ScoreBand } from "./band-tokens";

/** The per-metric hue keys the wellness strip passes to `<ScoreRing>`. */
export type RingHue = "readiness" | "sleep" | "recovery" | "stress" | "strain";

/**
 * Single-hue two-stop gradient `[from, to]` (dark → light) per metric, plus
 * a band fallback for the anatomy detail view (which passes no `hue`, so the
 * ring keeps its green/yellow/red band semantics there). Values are CSS
 * colour strings consumed straight by the SVG `<linearGradient>` stops.
 */
export const RING_GRADIENT: Record<RingHue | ScoreBand, [string, string]> = {
  // Readiness / Tagesform — a touch greener.
  readiness: ["color-mix(in srgb, var(--success) 88%, #000)", "var(--success)"],
  // Sleep score — bluer, leaning indigo via `--primary`.
  sleep: ["color-mix(in srgb, var(--info) 65%, var(--primary))", "var(--info)"],
  // Recovery — turquoise (cyan↔green).
  recovery: [
    "color-mix(in srgb, var(--dracula-cyan) 78%, var(--dracula-green))",
    "var(--dracula-cyan)",
  ],
  // Stress — amber (the "tension" metric; keeps the green/amber/red vocab honest).
  stress: ["color-mix(in srgb, var(--warning) 88%, #000)", "var(--warning)"],
  // Strain — turquoise leaning slightly violet to distinguish from Recovery.
  strain: [
    "color-mix(in srgb, var(--dracula-cyan) 80%, var(--dracula-purple))",
    "var(--dracula-cyan)",
  ],
  // Band fallback for the anatomy detail view (no per-metric hue passed):
  green: ["color-mix(in srgb, var(--success) 88%, #000)", "var(--success)"],
  yellow: ["color-mix(in srgb, var(--warning) 88%, #000)", "var(--warning)"],
  red: ["color-mix(in srgb, var(--destructive) 88%, #000)", "var(--destructive)"],
};

/**
 * The surface tint per metric — the `--tile-hue` the `.wellness-tile` CSS
 * mixes (gently) over the theme `--card`. Set inline by each `RingTile`.
 */
export const TILE_HUE: Record<RingHue, string> = {
  readiness: "var(--success)",
  sleep: "var(--info)",
  recovery: "var(--dracula-cyan)",
  stress: "var(--warning)",
  strain: "var(--dracula-cyan)",
};
