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
