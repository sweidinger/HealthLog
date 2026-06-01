import type {
  DailyBriefing,
  DailyBriefingKeyFinding,
} from "@/lib/ai/schema";

/**
 * v1.8.5 — derive the Insights overview "Trends" chart set from the
 * daily briefing.
 *
 * The Trends row used to be a fixed BP / weight / mood triple. The
 * briefing already surfaces the day's load-bearing findings (each one
 * tied to a `sourceMetric`), so the row should chart exactly those
 * flagged metrics — in the briefing's own priority order, deduped,
 * capped, with the legacy triple as the fallback when the briefing is
 * empty or unavailable.
 *
 * This module is the pure mapping layer:
 *   - `TREND_CHART_CONFIG` maps every briefing `sourceMetric` to a
 *     concrete chart descriptor (which measurement series to plot, its
 *     colour + unit + i18n title key, and whether the advisor supplies
 *     a one-sentence annotation for it).
 *   - `selectTrendCharts(briefing, opts)` walks the briefing findings,
 *     resolves each to a chart slot, dedupes, caps, and falls back to
 *     the default triple when nothing usable surfaces.
 *
 * Kept free of React/Recharts so the selection logic is unit-testable
 * in isolation and the renderer stays a thin consumer.
 */

/**
 * The annotation key the advisor populates for a slot, when one exists.
 * Only the legacy triple (bp / weight / mood) carries AI annotations in
 * `trendAnnotations`; every additive metric renders chart-only.
 */
export type TrendAnnotationKey = "bp" | "weight" | "mood";

/**
 * How the slot's chart is rendered. `mood` resolves to the bespoke
 * `<MoodChart>` (self-fetching, no measurement-type series); every
 * other slot resolves to `<HealthChart>` driven by `types`.
 */
export type TrendChartKind = "health-chart" | "mood";

export interface TrendChartConfig {
  /** Stable slot id — used as the `data-metric` attribute + React key. */
  metric: string;
  /** Which chart component to mount. */
  kind: TrendChartKind;
  /**
   * Measurement series for the `health-chart` kind. Empty for `mood`
   * (the mood chart self-fetches its own aggregate).
   */
  types: string[];
  /** Recharts stroke colours, positionally matched to `types`. */
  colors: string[];
  /** Display unit (chart legend / tooltip). */
  unit?: string;
  /** Y-axis unit label when it differs from the value unit. */
  yAxisUnit?: string;
  /** i18n key for the chart title (`charts.*`). */
  titleKey: string;
  /**
   * When set, the slot carries an advisor annotation under the chart
   * and uses the typed `<TrendAnnotation>` empty-state copy. Omitted
   * for additive metrics that render chart-only.
   */
  annotationKey?: TrendAnnotationKey;
}

/**
 * Per-`sourceMetric` chart descriptor. `null` marks a metric that has
 * no standalone trend chart in this row (compliance + the GLP-1
 * plateau finding are adherence-context observations, not a single
 * plottable series), so a finding on that metric is skipped during
 * selection and the next finding fills the slot instead.
 *
 * Colours + units mirror the dedicated sub-pages so a metric looks
 * identical whether the user lands on it here or on `/insights/<slug>`.
 */
export const TREND_CHART_CONFIG: Record<
  DailyBriefingKeyFinding["sourceMetric"],
  TrendChartConfig | null
> = {
  bp: {
    metric: "bp",
    kind: "health-chart",
    types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    colors: ["#ff79c6", "#8be9fd"],
    unit: "mmHg",
    yAxisUnit: "mmHg",
    titleKey: "charts.bloodPressure",
    annotationKey: "bp",
  },
  weight: {
    metric: "weight",
    kind: "health-chart",
    types: ["WEIGHT"],
    colors: ["#bd93f9"],
    unit: "kg",
    titleKey: "charts.weight",
    annotationKey: "weight",
  },
  pulse: {
    metric: "pulse",
    kind: "health-chart",
    types: ["PULSE"],
    colors: ["#50fa7b"],
    unit: "bpm",
    yAxisUnit: "bpm",
    titleKey: "charts.pulse",
  },
  mood: {
    metric: "mood",
    kind: "mood",
    types: [],
    colors: [],
    titleKey: "charts.mood",
    annotationKey: "mood",
  },
  sleep: {
    metric: "sleep",
    kind: "health-chart",
    types: ["SLEEP_DURATION"],
    colors: ["#8be9fd"],
    unit: "h",
    yAxisUnit: "h",
    titleKey: "charts.sleep",
  },
  steps: {
    metric: "steps",
    kind: "health-chart",
    types: ["ACTIVITY_STEPS"],
    colors: ["#50fa7b"],
    unit: "steps",
    yAxisUnit: "steps",
    titleKey: "charts.steps",
  },
  hrv: {
    metric: "hrv",
    kind: "health-chart",
    types: ["HEART_RATE_VARIABILITY"],
    colors: ["#bd93f9"],
    unit: "ms",
    yAxisUnit: "ms",
    titleKey: "charts.hrv",
  },
  resting_hr: {
    metric: "resting_hr",
    kind: "health-chart",
    types: ["RESTING_HEART_RATE"],
    colors: ["#ff79c6"],
    unit: "bpm",
    yAxisUnit: "bpm",
    titleKey: "charts.restingHeartRate",
  },
  active_energy: {
    metric: "active_energy",
    kind: "health-chart",
    types: ["ACTIVE_ENERGY_BURNED"],
    colors: ["#ffb86c"],
    unit: "kcal",
    yAxisUnit: "kcal",
    titleKey: "charts.activeEnergy",
  },
  flights: {
    metric: "flights",
    kind: "health-chart",
    types: ["FLIGHTS_CLIMBED"],
    colors: ["#f1fa8c"],
    unit: "flights",
    yAxisUnit: "flights",
    titleKey: "charts.flights",
  },
  distance: {
    metric: "distance",
    kind: "health-chart",
    types: ["WALKING_RUNNING_DISTANCE"],
    colors: ["#8be9fd"],
    unit: "km",
    yAxisUnit: "km",
    titleKey: "charts.distance",
  },
  vo2_max: {
    metric: "vo2_max",
    kind: "health-chart",
    types: ["VO2_MAX"],
    colors: ["#50fa7b"],
    unit: "mL/kg·min",
    yAxisUnit: "mL/kg·min",
    titleKey: "charts.vo2Max",
  },
  body_temp: {
    metric: "body_temp",
    kind: "health-chart",
    types: ["BODY_TEMPERATURE"],
    colors: ["#ff5555"],
    unit: "°C",
    yAxisUnit: "°C",
    titleKey: "charts.bodyTemperature",
  },
  // Adherence-context findings — no single plottable trend series in
  // this row. A finding on one of these is skipped during selection so
  // the next finding (or the default fallback) takes the slot.
  compliance: null,
  glp1_plateau: null,
};

/**
 * Default chart set when the briefing is empty / unavailable. Mirrors
 * the legacy fixed Trends triple so a cold mount, a web-only account
 * with no findings, or a pre-briefing payload keeps the familiar
 * BP / weight / mood row.
 */
export const DEFAULT_TREND_METRICS: ReadonlyArray<
  DailyBriefingKeyFinding["sourceMetric"]
> = ["bp", "weight", "mood"];

/** Max charts the row renders. Three keeps the equal-height 3-up grid. */
export const DEFAULT_TREND_CHART_CAP = 3;

export interface SelectTrendChartsOptions {
  /** Max number of charts to return. Defaults to {@link DEFAULT_TREND_CHART_CAP}. */
  cap?: number;
}

function configsFor(
  metrics: ReadonlyArray<DailyBriefingKeyFinding["sourceMetric"]>,
  cap: number,
): TrendChartConfig[] {
  const seen = new Set<string>();
  const out: TrendChartConfig[] = [];
  for (const metric of metrics) {
    if (out.length >= cap) break;
    const config = TREND_CHART_CONFIG[metric];
    if (!config) continue; // metric has no standalone trend chart
    if (seen.has(config.metric)) continue; // dedupe
    seen.add(config.metric);
    out.push(config);
  }
  return out;
}

/**
 * Resolve the Trends-row chart set from a daily briefing.
 *
 * Order follows the briefing's own `keyFindings` ordering (the model
 * emits the most load-bearing finding first). Metrics are deduped on
 * their chart slot and the result is capped. When the briefing is
 * `null`, carries no findings, or every finding maps to a
 * chartless metric, the default BP / weight / mood triple is returned
 * so the row never paints empty.
 */
export function selectTrendCharts(
  briefing: DailyBriefing | null | undefined,
  options: SelectTrendChartsOptions = {},
): TrendChartConfig[] {
  const cap = Math.max(1, options.cap ?? DEFAULT_TREND_CHART_CAP);

  const findingMetrics =
    briefing?.keyFindings?.map((f) => f.sourceMetric) ?? [];
  const fromBriefing = configsFor(findingMetrics, cap);

  if (fromBriefing.length > 0) {
    return fromBriefing;
  }

  return configsFor(DEFAULT_TREND_METRICS, cap);
}
