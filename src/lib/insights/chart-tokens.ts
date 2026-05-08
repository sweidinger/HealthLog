/**
 * Chart-include tokens for AI insight prose.
 *
 * The LLM can embed one of the literal strings below inside `summary` or
 * `findings[].label` to inline-render the matching chart underneath the
 * paragraph. Every token the model emits is matched against this allowlist
 * — anything else (typos, hallucinations, attempts to inject other strings)
 * is silently dropped before it ever reaches the renderer.
 *
 * Render path: prose → parseChartTokens(prose) → matching chart component
 * per token. The visible prose is run through stripChartTokens so the
 * literal token string never surfaces in the UI.
 */
// v1.4.3: allowlist extended with `metric:MOOD` so the AI can illustrate
// findings about mood drift inline. <MoodChart> is self-fetching, so the
// renderer just mounts it.
//
// `metric:COMPLIANCE` was prepared but pulled before ship — the existing
// <ComplianceLineChart> takes pre-aggregated daily data via props and
// has no self-fetching wrapper, so wiring it inline would silently
// render an empty chart. Land it in v1.5 once a self-fetching wrapper
// exists.
export const ALLOWED_CHART_TOKENS = [
  "metric:WEIGHT",
  "metric:BLOOD_PRESSURE_SYS",
  "metric:BLOOD_PRESSURE_DIA",
  "metric:PULSE",
  "metric:BODY_FAT",
  "metric:SLEEP_DURATION",
  "metric:ACTIVITY_STEPS",
  "metric:BLOOD_GLUCOSE",
  "metric:TOTAL_BODY_WATER",
  "metric:BONE_MASS",
  "metric:OXYGEN_SATURATION",
  "metric:MOOD",
] as const;

export type ChartToken = (typeof ALLOWED_CHART_TOKENS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_CHART_TOKENS);

// Greedy `[A-Z_]+` match. Uppercase letters and underscores only — anything
// else (apostrophes, spaces, lowercase, digits) terminates the token, so
// trailing junk like `metric:WEIGHT' onclick='alert(1)'` cleaves cleanly
// into the safe metric and an inert text remainder.
const TOKEN_REGEX = /metric:[A-Z_]+/g;

/**
 * Find every well-formed chart token in `text` and return only those that
 * are in the allowlist. Hallucinated tokens (e.g. `metric:NUKE`) are
 * silently dropped.
 */
export function parseChartTokens(text: string): ChartToken[] {
  const matches: string[] = text.match(TOKEN_REGEX) ?? [];
  return matches.filter((m): m is ChartToken => ALLOWED_SET.has(m));
}

/** Strip the chart tokens out of the visible insight text. */
export function stripChartTokens(text: string): string {
  return text
    .replace(TOKEN_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Map a chart token to the metric param the underlying chart component
 *  expects. For MeasurementType-backed tokens this is a real enum value
 *  (`WEIGHT`, `PULSE`, …); for `MOOD` and `COMPLIANCE` it's a synthetic
 *  identifier the renderer routes to a dedicated chart component. */
export function tokenToMetric(token: ChartToken): string {
  return token.slice("metric:".length);
}

/** Token kinds the renderer needs to distinguish. MeasurementType tokens
 *  feed `<HealthChart>`; `metric:MOOD` mounts the dedicated, self-fetching
 *  `<MoodChart>` instead. */
export function tokenKind(token: ChartToken): "measurement" | "mood" {
  if (token === "metric:MOOD") return "mood";
  return "measurement";
}
