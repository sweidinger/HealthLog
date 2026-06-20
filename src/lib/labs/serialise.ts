/**
 * v1.18.1 — server-authoritative lab-result DTO resolution.
 *
 * A lab row resolves its display name + unit + reference bounds in ONE place:
 *
 *  - If the row links a `Biomarker` (`biomarkerId` set), the canonical name,
 *    unit, and reference bounds come FROM THE BIOMARKER. The per-row legacy
 *    `analyte` / `unit` / `reference*` columns are ignored — they are stale
 *    historical truth at that point.
 *  - If the row is unlinked (legacy / pre-backfill), it falls back to its own
 *    free-text `analyte` / `unit` / `reference*` columns.
 *
 * Either way the verdict (`rangeStatus`) is computed from the RESOLVED bounds
 * via `classifyReferenceRange`. The DTO carries the resolved values so the web
 * client AND the iOS client render the same numbers — neither recomputes the
 * range or guesses the unit. This is the server-authoritative-parity rule for
 * Labs.
 */
import { classifyReferenceRange } from "@/lib/labs/reference-range";

/** The minimal biomarker shape the resolver needs (no encrypted context). */
export interface ResolvedBiomarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
}

/** The lab-result row shape the resolver reads (Prisma row subset). */
export interface LabRow {
  id: string;
  panel: string | null;
  analyte: string;
  /** Numeric reading; null for a qualitative row (see `valueText`). */
  value: number | null;
  /** v1.18.9 — qualitative result text; null for a numeric row. */
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: Date;
  source: string;
  biomarkerId: string | null;
  noteEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolve the canonical name / unit / bounds / panel for a lab row, preferring
 * the linked biomarker over the legacy per-row fields. Returns a plain shape
 * the list + detail serialisers both build on.
 */
export function resolveLabFields(
  row: Pick<
    LabRow,
    | "analyte"
    | "unit"
    | "referenceLow"
    | "referenceHigh"
    | "panel"
    | "biomarkerId"
  >,
  biomarker: ResolvedBiomarker | null | undefined,
): {
  analyte: string;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  panel: string | null;
} {
  if (biomarker) {
    return {
      analyte: biomarker.name,
      unit: biomarker.unit,
      referenceLow: biomarker.lowerBound,
      referenceHigh: biomarker.upperBound,
      panel: biomarker.panel,
    };
  }
  return {
    analyte: row.analyte,
    unit: row.unit,
    referenceLow: row.referenceLow,
    referenceHigh: row.referenceHigh,
    panel: row.panel,
  };
}

/**
 * v1.18.9 — the reference-range verdict for a row. A qualitative row (no
 * numeric `value`) has nothing to compare against the bounds, so it always
 * reports `"unknown"` — the neutral, no-verdict state — never a fabricated
 * in/out classification. A numeric row classifies against the resolved bounds.
 */
function rowRangeStatus(
  value: number | null,
  referenceLow: number | null,
  referenceHigh: number | null,
) {
  if (value === null) return "unknown" as const;
  return classifyReferenceRange(value, referenceLow, referenceHigh);
}

/**
 * Serialise a lab row to the list DTO — never echoes the encrypted note bytes
 * (only the `hasNote` flag) and resolves name/unit/range server-side.
 */
export function serialiseLabResult(
  row: LabRow,
  biomarker?: ResolvedBiomarker | null,
) {
  const resolved = resolveLabFields(row, biomarker);
  return {
    id: row.id,
    biomarkerId: row.biomarkerId,
    panel: resolved.panel,
    analyte: resolved.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: resolved.unit,
    referenceLow: resolved.referenceLow,
    referenceHigh: resolved.referenceHigh,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    hasNote: row.noteEncrypted !== null,
    rangeStatus: rowRangeStatus(
      row.value,
      resolved.referenceLow,
      resolved.referenceHigh,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialise a lab row to the detail DTO — same as the list DTO but carries the
 * decrypted `note` instead of the `hasNote` flag.
 */
export function serialiseLabResultDetail(
  row: LabRow,
  biomarker: ResolvedBiomarker | null | undefined,
  note: string | null,
) {
  const resolved = resolveLabFields(row, biomarker);
  return {
    id: row.id,
    biomarkerId: row.biomarkerId,
    panel: resolved.panel,
    analyte: resolved.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: resolved.unit,
    referenceLow: resolved.referenceLow,
    referenceHigh: resolved.referenceHigh,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    note,
    rangeStatus: rowRangeStatus(
      row.value,
      resolved.referenceLow,
      resolved.referenceHigh,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
