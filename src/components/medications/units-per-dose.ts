/**
 * v1.16.12 (#316) — fractional-dosing UI mapping.
 *
 * The wizard offers a CURATED set of units-per-dose values: the sub-unit
 * fractions (¼ ⅓ ½ ⅔ ¾, for split pills) plus a few whole numbers
 * (multi-tablet doses). The payload + API carry the DECIMAL value; the
 * UI renders the glyph. Kept beside the validator's
 * {@link UNITS_PER_DOSE_FRACTIONS} (one source of truth) — a test asserts
 * the fraction values here match the validator exactly, so the buttons
 * can never offer a value the server would 422.
 *
 * Thirds are inexact in decimal (⅓ → 0.3333, ⅔ → 0.6667); the column is
 * Decimal(10,4) and the runway floor absorbs the sub-0.0001 drift.
 */
const FRACTION_GLYPHS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 0.25, glyph: "¼" },
  { value: 0.3333, glyph: "⅓" },
  { value: 0.5, glyph: "½" },
  { value: 0.6667, glyph: "⅔" },
  { value: 0.75, glyph: "¾" },
];

/** The curated whole-number doses shown alongside the fractions. */
const WHOLE_OPTIONS = [1, 2, 3, 4] as const;

export interface UnitsPerDoseOption {
  /** Numeric value (e.g. 0.5). */
  value: number;
  /** The string stored in the wizard payload + sent to the API. */
  raw: string;
  /** Display glyph / number (e.g. "½", "2"). */
  label: string;
}

/** Curated selector options: fractions first (½ reads naturally before 1), then wholes. */
export const UNITS_PER_DOSE_OPTIONS: UnitsPerDoseOption[] = [
  ...FRACTION_GLYPHS.map((f) => ({
    value: f.value,
    raw: String(f.value),
    label: f.glyph,
  })),
  ...WHOLE_OPTIONS.map((n) => ({
    value: n,
    raw: String(n),
    label: String(n),
  })),
];

/**
 * The exact fraction decimals the UI offers — exported for the alignment
 * test, which asserts (in Node, where server imports are fine) that this
 * equals the validator's `UNITS_PER_DOSE_FRACTIONS`. This module itself
 * stays free of any server import so it can ship in the client bundle.
 */
export const UNITS_PER_DOSE_FRACTION_VALUES = FRACTION_GLYPHS.map(
  (f) => f.value,
);

/**
 * Round a unit count for display — drops the float noise a ⅓-dose
 * (0.3333/dose) leaves in a running remainder (29.6667 → 29.67). Whole
 * and ½ counts pass through unchanged.
 */
export function formatUnitCount(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Render a stored units-per-dose decimal: the fraction glyph (¼ … ¾) when
 * it matches a curated fraction, else the plain number ("2", "10").
 */
export function formatUnitsPerDose(value: number): string {
  const hit = FRACTION_GLYPHS.find((f) => Math.abs(f.value - value) < 0.001);
  return hit ? hit.glyph : String(value);
}

/**
 * The selector options for a given current value: the curated set, plus
 * the current value appended when it is a legacy / non-curated positive
 * number (e.g. an existing medication set to 10 units per dose), so an
 * edit never silently drops it.
 */
export function unitsPerDoseOptionsFor(current: string): UnitsPerDoseOption[] {
  if (UNITS_PER_DOSE_OPTIONS.some((o) => o.raw === current)) {
    return UNITS_PER_DOSE_OPTIONS;
  }
  const n = Number(current);
  if (Number.isFinite(n) && n > 0) {
    return [
      ...UNITS_PER_DOSE_OPTIONS,
      { value: n, raw: current, label: formatUnitsPerDose(n) },
    ];
  }
  return UNITS_PER_DOSE_OPTIONS;
}
