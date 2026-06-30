import { DOSE_UNIT_KEYS } from "./dose-units";

/**
 * Display-time dose formatter.
 *
 * The wizard composes `Medication.dose` as a free-text string
 * `"{amount} {unitKey}"` storing the RAW unit key (e.g. "1 pieces",
 * "5 mg"). Rendered verbatim that leaks the untranslated English key onto
 * the card — "Test ABC 1 pieces" even on a German UI. This helper splits
 * the amount from the unit and, when the unit is one of the canonical
 * {@link DOSE_UNIT_KEYS}, swaps it for the localised label
 * (`medications.wizard.steps.step3.unit.<key>`). A custom free-text dose
 * the wizard never produced (e.g. "1 puff morning") passes through
 * unchanged.
 *
 * Pure + SSR-safe: takes the `t` accessor as a parameter, no React hook.
 */

// Mirrors `parseDoseExpression` in wizard-payload.ts — split on a leading
// number ("5 mg" → {amount:"5", unit:"mg"}); no number → {amount:"", unit:raw}.
const DOSE_EXPR_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;

const KNOWN_UNITS = new Set<string>(DOSE_UNIT_KEYS);

export function formatDose(
  raw: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const match = DOSE_EXPR_RE.exec(trimmed);
  const amount = match ? (match[1] ?? "") : "";
  const unit = match ? (match[2] ?? "").trim() : trimmed;

  const key = unit.toLowerCase();
  if (KNOWN_UNITS.has(key)) {
    const label = t(`medications.wizard.steps.step3.unit.${key}`);
    return amount ? `${amount} ${label}` : label;
  }

  // Custom free-text dose (the wizard never minted this unit) — leave it be.
  return raw;
}
