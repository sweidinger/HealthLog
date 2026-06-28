/**
 * v1.25 (W-ENV) — the canonical environmental-exposure field vocabulary.
 *
 * One declarative table that names each daily weather/daylight field HealthLog
 * stores AND correlates. It is the single source the two surfaces speak:
 *
 *   - the SIGNAL REGISTRY (`src/lib/signals/registry.ts`) registers one
 *     `kind:"environment"` signal per field here, so each gets a stable signal
 *     key + display metadata for free; and
 *   - the CORRELATION ENGINE reads {@link ENVIRONMENT_CHANNEL_KEYS} to fold the
 *     same fields in as lagged BEHAVIOUR (exposure) channels against mood /
 *     sleep / vitals.
 *
 * `key` doubles as the registry signal key AND the correlation channel key —
 * the `ENV_` prefix keeps it from colliding with a `MeasurementType` and lets
 * `metricFamily()` collapse all env channels into one `ENVIRONMENT` family (so
 * the engine never lag-correlates two same-day weather fields against each
 * other — that is a near-tautology, not an insight).
 *
 * `column` is the `EnvironmentContext` numeric column the field reads. Leaf
 * module (no imports) so both the registry and the pure correlation engine can
 * depend on it without a cycle.
 */

/** The `EnvironmentContext` numeric columns a correlation field can read. */
export type EnvironmentContextNumericColumn =
  | "tempMean"
  | "tempMin"
  | "tempMax"
  | "apparentMean"
  | "sunshineSec"
  | "daylightSec"
  | "precipSum"
  | "pressureMean"
  | "pressureDelta"
  | "humidityMean"
  | "cloudMean";

export interface EnvironmentField {
  /** Stable key — the registry signal key AND the correlation channel key. */
  key: string;
  /** The `EnvironmentContext` column this field's daily value comes from. */
  column: EnvironmentContextNumericColumn;
  /** Canonical unit (English, for prose + registry metadata). */
  unit: string;
  /** Stable English display name (the UI localises via `i18nLabelKey`). */
  displayName: string;
  /** Lower-cased phrase the correlation narration ("humanise") reads. */
  narrationLabel: string;
  /** i18n label key resolved by the correlation / settings surfaces. */
  i18nLabelKey: string;
}

/**
 * The exposure fields, ranked by evidence in the W-ENV research review:
 * temperature (sleep / BP / recovery), sunshine + daylight (mood), precipitation
 * (activity), pressure mean + intraday swing (headache/symptom — honestly
 * caveated, optional-strength). All are BEHAVIOUR (lag-source) channels.
 */
export const ENVIRONMENT_FIELDS: readonly EnvironmentField[] = [
  {
    key: "ENV_TEMP_MEAN",
    column: "tempMean",
    unit: "°C",
    displayName: "Daily temperature",
    narrationLabel: "daily temperature",
    i18nLabelKey: "environment.fields.tempMean",
  },
  {
    key: "ENV_TEMP_MIN",
    column: "tempMin",
    unit: "°C",
    displayName: "Overnight low temperature",
    narrationLabel: "overnight low temperature",
    i18nLabelKey: "environment.fields.tempMin",
  },
  {
    key: "ENV_SUNSHINE",
    column: "sunshineSec",
    unit: "h",
    displayName: "Sunshine duration",
    narrationLabel: "sunshine",
    i18nLabelKey: "environment.fields.sunshine",
  },
  {
    key: "ENV_DAYLIGHT",
    column: "daylightSec",
    unit: "h",
    displayName: "Daylight length",
    narrationLabel: "daylight",
    i18nLabelKey: "environment.fields.daylight",
  },
  {
    key: "ENV_PRECIP",
    column: "precipSum",
    unit: "mm",
    displayName: "Precipitation",
    narrationLabel: "precipitation",
    i18nLabelKey: "environment.fields.precip",
  },
  {
    key: "ENV_PRESSURE_MEAN",
    column: "pressureMean",
    unit: "hPa",
    displayName: "Barometric pressure",
    narrationLabel: "barometric pressure",
    i18nLabelKey: "environment.fields.pressureMean",
  },
  {
    key: "ENV_PRESSURE_DELTA",
    column: "pressureDelta",
    unit: "hPa",
    displayName: "Pressure swing",
    narrationLabel: "intraday pressure swing",
    i18nLabelKey: "environment.fields.pressureDelta",
  },
] as const;

/** The correlation channel keys, in declaration order. */
export const ENVIRONMENT_CHANNEL_KEYS: readonly string[] =
  ENVIRONMENT_FIELDS.map((f) => f.key);

/** True for a registered environmental channel key. */
export function isEnvironmentChannelKey(key: string): boolean {
  return ENVIRONMENT_CHANNEL_KEYS.includes(key);
}

/** Resolve a field by its key, or null when unregistered. */
export function getEnvironmentField(key: string): EnvironmentField | null {
  return ENVIRONMENT_FIELDS.find((f) => f.key === key) ?? null;
}
