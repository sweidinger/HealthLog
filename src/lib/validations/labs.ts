/**
 * v1.17.1 — structured lab-result store.
 *
 * A minimal, generic `LabResult` capture path: a self-hoster records a
 * biomarker reading (HbA1c, LDL, ferritin, TSH, …) with its value, unit,
 * the lab's reference range, and the sample date. Pairs with the v1.17.1
 * Vorsorge annual-blood-panel reminder, which otherwise has nowhere to
 * record the result it reminds the user to obtain.
 *
 * The model is intentionally free-form on `analyte` + `unit` (no closed
 * LOINC enum): a lab report prints whatever name and unit it likes, and a
 * forced taxonomy would reject real-world values. The optional `panel`
 * groups analytes that arrived together (e.g. "Großes Blutbild").
 */
import { z } from "zod/v4";

import { validateEntryInstant } from "@/lib/validations/entry-instant";

/**
 * Far-past floor for a lab sample. A self-hoster legitimately backdates an
 * old paper report, so the window is generous (50 years) but still rejects
 * epoch-zero / corrupted-import instants via the shared 1900 floor.
 */
const LAB_TAKEN_AT_MAX_AGE_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;

/** Shared `takenAt` field: ISO string → Date, plausibility-bounded. */
const takenAtField = validateEntryInstant(
  z
    .string()
    .datetime({ message: "takenAt must be an ISO 8601 datetime" })
    .transform((s) => new Date(s)),
  {
    maxAgeMs: LAB_TAKEN_AT_MAX_AGE_MS,
    pastMessage: "Sample date is too far in the past",
  },
);

/** Trimmed, bounded free-text field with a min-length guard. */
const requiredText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max);

const optionalPanel = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  // An empty-string panel is normalised to "no panel" so the grouping
  // stays NULL-distinct rather than carrying a blank label.
  .or(z.literal("").transform(() => undefined));

const optionalNote = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * Reference bounds are independently optional (a lab may report only an
 * upper bound, e.g. LDL < 116). When BOTH are present the low bound must
 * not exceed the high bound — a transposed range is a client error.
 */
const referenceLow = z.number().finite().optional();
const referenceHigh = z.number().finite().optional();

export const createLabResultSchema = z
  .object({
    panel: optionalPanel,
    analyte: requiredText(120),
    value: z.number().finite(),
    unit: requiredText(40),
    referenceLow,
    referenceHigh,
    takenAt: takenAtField,
    note: optionalNote,
  })
  .refine(
    (d) =>
      d.referenceLow === undefined ||
      d.referenceHigh === undefined ||
      d.referenceLow <= d.referenceHigh,
    {
      message: "referenceLow must not exceed referenceHigh",
      path: ["referenceLow"],
    },
  );

export type CreateLabResultInput = z.infer<typeof createLabResultSchema>;

/**
 * Update schema: every field optional (partial edit). `panel` and `note`
 * accept an explicit `null` to clear the stored value — distinct from an
 * omitted key, which leaves the column untouched.
 */
export const updateLabResultSchema = z
  .object({
    panel: optionalPanel.or(z.null()),
    analyte: requiredText(120).optional(),
    value: z.number().finite().optional(),
    unit: requiredText(40).optional(),
    referenceLow: referenceLow.or(z.null()),
    referenceHigh: referenceHigh.or(z.null()),
    takenAt: takenAtField.optional(),
    note: optionalNote.or(z.null()),
  })
  .refine(
    (d) =>
      d.referenceLow === undefined ||
      d.referenceLow === null ||
      d.referenceHigh === undefined ||
      d.referenceHigh === null ||
      d.referenceLow <= d.referenceHigh,
    {
      message: "referenceLow must not exceed referenceHigh",
      path: ["referenceLow"],
    },
  );

export type UpdateLabResultInput = z.infer<typeof updateLabResultSchema>;

/** List query: filter by analyte (exact) + date range, paginate. */
export const listLabResultsSchema = z.object({
  analyte: z.string().trim().min(1).max(120).optional(),
  panel: z.string().trim().min(1).max(120).optional(),
  from: z
    .string()
    .datetime()
    .transform((s) => new Date(s))
    .optional(),
  to: z
    .string()
    .datetime()
    .transform((s) => new Date(s))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListLabResultsInput = z.infer<typeof listLabResultsSchema>;

/**
 * Reference-range classification. Deliberately a three-state, NEUTRAL
 * verdict — the badge that renders it must stay calm and informative, NOT
 * alarming (no red "out of range" tint). `"unknown"` when the lab reported
 * no usable bounds.
 *
 * Bounds are treated as inclusive: a value exactly on the reference limit
 * reads as in-range, matching how labs print "≤" / "≥" reference notation.
 */
export type ReferenceRangeStatus = "in-range" | "below" | "above" | "unknown";

export function classifyReferenceRange(
  value: number,
  referenceLow: number | null | undefined,
  referenceHigh: number | null | undefined,
): ReferenceRangeStatus {
  const hasLow = referenceLow !== null && referenceLow !== undefined;
  const hasHigh = referenceHigh !== null && referenceHigh !== undefined;
  if (!hasLow && !hasHigh) return "unknown";
  if (hasLow && value < (referenceLow as number)) return "below";
  if (hasHigh && value > (referenceHigh as number)) return "above";
  return "in-range";
}
