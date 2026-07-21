import { z } from "zod/v4";

import { INJECTION_SITE_KEYS } from "@/lib/medications/injection-sites";
import { validateEntryInstant } from "@/lib/validations/entry-instant";

/**
 * v1.8.5 — the eight injection-site enum values, mirrored from the
 * Prisma `InjectionSite` enum via the shared `INJECTION_SITE_KEYS`
 * tuple. Reused by the intake + bulk-intake request schemas (the
 * `injectionSite` field) and the per-medication allowed-sites editor.
 */
export const INJECTION_SITE_VALUES = INJECTION_SITE_KEYS;
export type InjectionSiteValue = (typeof INJECTION_SITE_VALUES)[number];

/** Zod enum over the eight injection sites. */
export const injectionSiteEnum = z.enum(INJECTION_SITE_VALUES);

export const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * v1.9.0 — drug-classification code formats.
 *
 * `ATC_CODE_REGEX` — the 7-character WHO ATC code (one letter, two
 * digits, two letters, two digits, e.g. `A10BX10`). This is the
 * full leaf-level substance class; the shorter anatomical-group
 * prefixes (`A`, `A10`, `A10B`) are deliberately NOT accepted — the
 * exporter emits a substance-class coding, not a group.
 *
 * `RXCUI_REGEX` — the RxNorm RxCUI is a bare positive integer string
 * (e.g. `2601723`).
 *
 * Both fields are user/clinician-asserted and never machine-guessed;
 * a malformed value is rejected with 422 rather than silently stored.
 */
const ATC_CODE_REGEX = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;
const RXCUI_REGEX = /^\d+$/;

/**
 * v1.9.0 — reusable nullable/optional code-field validators shared by
 * the create + update medication schemas. `null` clears the column;
 * `undefined` leaves it untouched on update.
 */
export const atcCodeField = z
  .string()
  .regex(ATC_CODE_REGEX, "Invalid ATC code (expected e.g. A10BX10)")
  .nullable()
  .optional()
  .describe(
    "Optional WHO ATC classification code (active-substance class, 7 chars, e.g. `A10BX10`). User/clinician-asserted; never machine-guessed. Emitted on the FHIR `medicationCodeableConcept` under `http://www.whocc.no/atc`. NULL clears it; absent leaves it untouched.",
  );
export const rxNormCodeField = z
  .string()
  .regex(RXCUI_REGEX, "Invalid RxNorm code (expected a numeric RxCUI)")
  // Defence-in-depth: the `^\d+$` regex is otherwise unbounded. Real
  // RxCUIs are at most 7 digits today; 20 is a generous ceiling that
  // still bounds the column write tightly. (`atcCode` needs no max —
  // its regex already fixes the length at 7.)
  .max(20, "RxNorm code is too long")
  .nullable()
  .optional()
  .describe(
    "Optional RxNorm RxCUI (numeric, US identifier, e.g. `2601723`). Secondary coding emitted under `http://www.nlm.nih.gov/research/umls/rxnorm` alongside any ATC code, never instead of the free-text name. NULL clears it; absent leaves it untouched.",
  );
/**
 * Clinical-category values stored in the `medication_categories` side-
 * table (TEXT column). v1.5.4 adds `DIABETES` and `ANTIBIOTIC` so the
 * wizard's Step 2 taxonomy can write a first-class bucket for those
 * two rows instead of collapsing them into `OTHER`. The column is a
 * plain TEXT field — no Prisma enum exists to migrate; the Zod values
 * list is the only enforcement layer.
 */
export const MEDICATION_CATEGORY_VALUES = [
  "BLOOD_PRESSURE",
  "VITAMIN",
  "SUPPLEMENT",
  "PAIN_RELIEF",
  "ALLERGY",
  "DIGESTIVE",
  "THYROID",
  "HORMONE",
  "SKIN",
  "SLEEP_AID",
  "DIABETES",
  "ANTIBIOTIC",
  "OTHER",
] as const;
export type MedicationCategoryValue =
  (typeof MEDICATION_CATEGORY_VALUES)[number];

/**
 * v1.4.25 W4d — Prisma-level treatment class. Orthogonal to
 * `MEDICATION_CATEGORY_VALUES` (the clinical taxonomy that lives in the
 * `medication_categories` side-table). GLP1 turns on the GLP-1
 * specialist surfaces — injection-site picker, titration history, pen
 * inventory, GLP-1-aware Coach replies. Future treatment classes drop
 * into this list (INSULIN, BIOLOGIC, FERTILITY, …).
 */
export const MEDICATION_TREATMENT_CLASS_VALUES = [
  "GENERIC",
  "GLP1",
  "STIMULANT",
] as const;
export type MedicationTreatmentClass =
  (typeof MEDICATION_TREATMENT_CLASS_VALUES)[number];

/**
 * v1.16.12 (#316) — fractional dosing. A dose may consume a sub-unit
 * fraction of a tablet (split pills). The UI offers a CURATED set of
 * common fractions (¼ ⅓ ½ ⅔ ¾), stored as their decimal value; thirds
 * are inexact in decimal (⅓ ≈ 0.3333, ⅔ ≈ 0.6667) — the @db.Decimal(10,4)
 * column and the runway floor absorb the sub-0.0001 drift. Whole numbers
 * 1..100 (multi-tablet doses, the pre-v1.16.12 contract) stay valid
 * alongside the fractions. One source of truth — the UI selector and the
 * tests import this set so the allowed values can never drift from the
 * validator.
 */
export const UNITS_PER_DOSE_FRACTIONS = [
  0.25, 0.3333, 0.5, 0.6667, 0.75,
] as const;
export const UNITS_PER_DOSE_MAX_WHOLE = 100;

export function isSupportedUnitsPerDose(value: number): boolean {
  if ((UNITS_PER_DOSE_FRACTIONS as readonly number[]).includes(value)) {
    return true;
  }
  return (
    Number.isInteger(value) && value >= 1 && value <= UNITS_PER_DOSE_MAX_WHOLE
  );
}

export const UNITS_PER_DOSE_MESSAGE =
  "unitsPerDose must be a whole number 1–100 or a supported fraction (¼, ⅓, ½, ⅔, ¾)";

/**
 * v1.6.0 — route of administration. Decoupled from `treatmentClass`:
 * the injection-site picker surfaces for any `INJECTION` dose, and a
 * one-time injection is `oneShot: true` + `deliveryForm: "INJECTION"`.
 * ORAL is the default the migration backfilled onto every existing row.
 */
export const MEDICATION_DELIVERY_FORM_VALUES = [
  "ORAL",
  "INJECTION",
  "OTHER",
] as const;
export type MedicationDeliveryForm =
  (typeof MEDICATION_DELIVERY_FORM_VALUES)[number];

/**
 * v1.5 — RRULE string shape check.
 *
 * Not a full RFC 5545 parser (that lives in the `rrule` npm package on
 * the server side). The regex catches the subset HealthLog mints from
 * the wizard / form: a `FREQ=` line with optional `INTERVAL=`,
 * `BYDAY=`, `BYMONTHDAY=`, `BYMONTH=`, `COUNT=`, `UNTIL=` properties
 * separated by `;`. Any pathological-looking shape (the `FREQ=SECONDLY`
 * DoS surface, `;COUNT=999999999`) is filtered at the server route
 * layer with a hard cap on emitted occurrences.
 */
export const RRULE_PROPS =
  /^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;(?:INTERVAL=\d{1,3}|BYDAY=(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*|BYMONTHDAY=-?\d{1,2}(?:,-?\d{1,2})*|BYMONTH=\d{1,2}(?:,\d{1,2})*|COUNT=\d{1,4}|UNTIL=\d{8}T\d{6}Z))*$/;

/**
 * v1.15.18 — one explicit per-dose on-time window. `timeOfDay` keys the dose
 * the window applies to; `start`/`end` are the HH:mm on-time bounds in the
 * user's wall clock. `start <= end` within the day (an overnight window is not
 * a configurable on-time band — the late tail owns the cross-midnight tail).
 */
export const doseWindowEntrySchema = z
  .object({
    timeOfDay: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "The dose time this window applies to (matches a `timesOfDay` entry).",
      ),
    start: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe("On-time band lower bound (HH:mm, user local)."),
    end: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "On-time band upper bound (HH:mm, user local). Must be >= `start`.",
      ),
  })
  .refine((w) => hhmmToMinutes(w.start) <= hhmmToMinutes(w.end), {
    message: "Window start must be on or before end (same day)",
    path: ["end"],
  })
  .meta({
    id: "DoseWindowEntry",
    description:
      "One explicit per-dose on-time intake window. `timeOfDay` matches a schedule dose time; `[start, end]` (HH:mm, user local, `start <= end`) is the on-time band. Outside it the cadence-derived late tail applies, then ad-hoc.",
  });

/** Minutes-since-midnight for an `HH:mm` literal (already regex-validated). */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * v1.15.19 introduced `takenAt` plausibility bounds on the EDIT path
 * (audit P0-4); v1.16.9 lifts them onto every CREATE path too (the
 * per-medication intake POST, the bulk endpoint, the external ingest) so
 * the retro-add dialog and a hand-rolled API call can't insert a row a
 * decade in the past or hours in the future. Future allowance covers
 * client clock skew; the 5-year floor matches the GLP-1 dose-change
 * validator's window. Slot-distance / medication-start checks stay in
 * the routes — the schema cannot see the medication.
 */
export const TAKEN_AT_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * ISO `takenAt` → `Date` with the plausibility bounds applied.
 *
 * v1.17 W1b — delegates to the shared `validateEntryInstant` helper (the
 * same bound now guarding `measuredAt` + `moodLoggedAt`), passing the
 * five-year window so a stale backdated dose is rejected well before the
 * 1900 floor. The 5-min clock-skew tolerance is the shared default.
 */
export const boundedTakenAtSchema = validateEntryInstant(
  z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  {
    maxAgeMs: TAKEN_AT_MAX_AGE_MS,
    // Preserve the established wording so the iOS contract + tests stay stable.
    pastMessage: "takenAt must be within the last 5 years",
  },
);
