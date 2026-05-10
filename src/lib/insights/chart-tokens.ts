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

// v1.4.19 A3 — strip vs parse split. The strip-side character class
// is permissive (`[A-Za-z0-9_]+`) so model-emitted lowercase or
// snake_case tokens like `metric:blood_pressure_sweet_spot` (verbatim
// maintainer probe 2026-05-10) get cleaved out of prose instead of leaking to the
// DOM. The parse-side class stays uppercase-only so unrenderable /
// hallucinated tokens are dropped from the *render* path entirely;
// only the *strip* is permissive.
//
// Trailing junk like `metric:WEIGHT' onclick='alert(1)'` still
// cleaves cleanly: the apostrophe terminates either character class,
// and the surviving uppercase token is the only one filtered through
// the allowlist for rendering.
const STRIP_TOKEN_REGEX = /metric:[A-Za-z0-9_]+/g;
const PARSE_TOKEN_REGEX = /metric:[A-Z_]+/g;

/**
 * Find every well-formed chart token in `text` and return only those that
 * are in the allowlist. Hallucinated tokens (e.g. `metric:NUKE`) are
 * silently dropped.
 *
 * v1.4.17 hotfix: legacy cached payloads from before the strict insight
 * schema landed can deliver `undefined` here when the consumer reads a
 * field that didn't exist in the v1.4.14 shape (e.g. `insight.summary`
 * on a `{changed, stable, drivers, ...}` blob). Rather than crashing
 * the entire `/insights` page on a `text.match` of undefined, treat
 * non-string input as empty — the legacy-payload CTA owns the user-
 * facing recovery path.
 */
export function parseChartTokens(
  text: string | null | undefined,
): ChartToken[] {
  if (typeof text !== "string") return [];
  const matches: string[] = text.match(PARSE_TOKEN_REGEX) ?? [];
  return matches.filter((m): m is ChartToken => ALLOWED_SET.has(m));
}

/**
 * Strip the chart tokens out of the visible insight text.
 *
 * v1.4.17 hotfix: same defensive contract as `parseChartTokens()` —
 * non-string input returns the empty string instead of crashing the
 * caller. The empty result keeps the surrounding JSX render path
 * (`<p>{stripChartTokens(insight.summary)}</p>`) alive so the legacy-
 * payload CTA above it gets a chance to surface to the user.
 */
export function stripChartTokens(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .replace(STRIP_TOKEN_REGEX, "")
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
