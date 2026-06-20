/**
 * v1.18.1 — shared lab-value number formatting.
 *
 * The list card, the detail history rows, and the chart tooltip all trim a
 * lab reading the same way: whole numbers render bare, fractional values keep
 * up to two decimals (no trailing-zero noise). Centralised so the three
 * surfaces stay byte-identical.
 */
export function formatLabValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)));
}

/**
 * v1.18.9 — render a reading's display value: a qualitative row (numeric
 * `value` is null) shows its `valueText` verbatim; a numeric row shows the
 * formatted number plus its unit. One helper so the list card, the history
 * rows, and the detail header stay consistent.
 */
export function formatLabReading(reading: {
  value: number | null;
  valueText: string | null;
  unit: string;
}): string {
  if (reading.value === null) {
    return reading.valueText ?? "";
  }
  return `${formatLabValue(reading.value)} ${reading.unit}`.trim();
}
