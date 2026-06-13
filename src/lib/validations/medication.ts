import { z } from "zod/v4";

import { SCHEDULE_TYPES } from "@/lib/medications/scheduling/recurrence";
import { INJECTION_SITE_KEYS } from "@/lib/medications/injection-sites";

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

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
const atcCodeField = z
  .string()
  .regex(ATC_CODE_REGEX, "Invalid ATC code (expected e.g. A10BX10)")
  .nullable()
  .optional()
  .describe(
    "Optional WHO ATC classification code (active-substance class, 7 chars, e.g. `A10BX10`). User/clinician-asserted; never machine-guessed. Emitted on the FHIR `medicationCodeableConcept` under `http://www.whocc.no/atc`. NULL clears it; absent leaves it untouched.",
  );
const rxNormCodeField = z
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
export type MedicationCategoryValue = (typeof MEDICATION_CATEGORY_VALUES)[number];

/**
 * v1.4.25 W4d — Prisma-level treatment class. Orthogonal to
 * `MEDICATION_CATEGORY_VALUES` (the clinical taxonomy that lives in the
 * `medication_categories` side-table). GLP1 turns on the GLP-1
 * specialist surfaces — injection-site picker, titration history, pen
 * inventory, GLP-1-aware Coach replies. Future treatment classes drop
 * into this list (INSULIN, BIOLOGIC, FERTILITY, …).
 */
export const MEDICATION_TREATMENT_CLASS_VALUES = ["GENERIC", "GLP1"] as const;
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
  if (
    (UNITS_PER_DOSE_FRACTIONS as readonly number[]).includes(value)
  ) {
    return true;
  }
  return (
    Number.isInteger(value) && value >= 1 && value <= UNITS_PER_DOSE_MAX_WHOLE
  );
}

const UNITS_PER_DOSE_MESSAGE =
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
const RRULE_PROPS =
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
      .describe("The dose time this window applies to (matches a `timesOfDay` entry)."),
    start: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe("On-time band lower bound (HH:mm, user local)."),
    end: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe("On-time band upper bound (HH:mm, user local). Must be >= `start`."),
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
function hhmmToMinutes(hhmm: string): number {
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
export const TAKEN_AT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const TAKEN_AT_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** ISO `takenAt` → `Date` with the shared plausibility bounds applied. */
export const boundedTakenAtSchema = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() <= Date.now() + TAKEN_AT_CLOCK_SKEW_MS, {
    message: "takenAt must not be in the future",
  })
  .refine((d) => d.getTime() >= Date.now() - TAKEN_AT_MAX_AGE_MS, {
    message: "takenAt must be within the last 5 years",
  });

export const scheduleSchema = z
  .object({
    windowStart: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). v1.5 keeps the field for backwards compatibility with pre-wizard iOS clients; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .regex(timeRegex, "Format: HH:mm")
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z
      .string()
      .max(50)
      .optional()
      .describe("Optional human label (e.g. \"Morning\", \"Evening\")."),
    dose: z
      .string()
      .max(50)
      .optional()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .optional()
      .describe(
        "Legacy day-of-week filter (0=Sunday..6=Saturday). v1.5 reads new writes through `rrule` first; this field is preserved for pre-v1.5 rows and is the input the route serialises into the persisted `days_of_week` string.",
      ),
    intervalWeeks: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe(
        "Legacy multi-week stride (1..4). Bi-weekly + tri-weekly were broken in the pre-v1.5 reminder worker; new writes encode the same intent via `rrule` (e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE`).",
      ),
    /**
     * v1.5 — first-class times-of-day. One or more HH:mm entries in
     * the user's wall-clock; the engine applies them per matched day.
     * Empty array falls back to `[windowStart]` for backwards-compat.
     */
    timesOfDay: z
      .array(z.string().regex(timeRegex, "Format: HH:mm"))
      .max(8)
      .optional()
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Up to 8 entries. Absent or empty means the route stamps `[windowStart]` so the new engine always sees a populated array.",
      ),
    /**
     * v1.5 — reminder grace window (minutes). Replaces the implicit
     * `windowEnd - windowStart` span for late-classification. NULL
     * falls back to the legacy span. Capped at 24 hours.
     */
    reminderGraceMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional()
      .describe(
        "Reminder grace window in minutes. Caps at 24h. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    /**
     * v1.5 — RFC 5545 RRULE string for calendar-anchored cadences.
     * Mutually exclusive with `rollingIntervalDays`.
     */
    rrule: z
      .string()
      .max(200)
      .regex(RRULE_PROPS, "Invalid RRULE")
      .optional()
      .describe(
        "RFC 5545 RRULE string (subset). Use for daily / weekly-with-BYDAY / multi-week / monthly / yearly cadences. Mutually exclusive with `rollingIntervalDays`. Examples: `FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=MO,WE,FR`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE`, `FREQ=MONTHLY;BYMONTHDAY=1`, `FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1`.",
      ),
    /**
     * v1.5 — flexible-rolling interval in days, counted from the
     * latest MedicationIntakeEvent.takenAt. Mutually exclusive with
     * `rrule`. Range 1..365 days.
     */
    rollingIntervalDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt` (the dose re-anchors when logged). Mutually exclusive with `rrule`. Range 1..365.",
      ),
    /**
     * v1.7.0 — schedule-type discriminator. SCHEDULED (default) keeps the
     * rrule / rolling / legacy cadence. PRN is as-needed (never projected,
     * reminded, or counted in compliance expected; still loggable).
     * CYCLIC wraps the inner cadence with an N-on / M-off week phase.
     */
    scheduleType: z
      .enum(SCHEDULE_TYPES)
      .optional()
      .describe(
        "Schedule type. SCHEDULED (default) = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    /** v1.7.0 — cyclic "on" weeks. Required when `scheduleType === "CYCLIC"`. */
    cyclicOnWeeks: z
      .number()
      .int()
      .min(1)
      .max(52)
      .optional()
      .describe(
        "Cyclic \"on\" weeks (1..52). Required when `scheduleType` is CYCLIC; ignored otherwise.",
      ),
    /** v1.7.0 — cyclic "off" weeks. Required when `scheduleType === "CYCLIC"`. */
    cyclicOffWeeks: z
      .number()
      .int()
      .min(0)
      .max(52)
      .optional()
      .describe(
        "Cyclic \"off\" weeks (0..52). Required when `scheduleType` is CYCLIC; ignored otherwise.",
      ),
    /**
     * v1.15.18 — per-dose configurable on-time intake window (the maintainer's
     * "07:00–09:00" lever). One entry per dose time the user wants an explicit
     * range for; a `timeOfDay` with no entry keeps the symmetric ±1h default.
     * Each `timeOfDay` MUST match one of the schedule's `timesOfDay` (or the
     * legacy `windowStart`), and `start <= end` within the day. Absent → every
     * slot uses the default derivation (unchanged behaviour).
     */
    doseWindows: z
      .array(doseWindowEntrySchema)
      .max(8)
      .optional()
      .describe(
        "Per-dose on-time intake windows. Each `{ timeOfDay, start, end }` HH:mm triple sets the explicit on-time band for the matching dose time; a dose time with no entry keeps the symmetric ±1h default. `timeOfDay` must match one of `timesOfDay` (or `windowStart`); `start <= end`. Up to 8 entries. Absent leaves every slot on the default derivation. The late tail stays cadence-derived.",
      ),
  })
  .refine(
    (s) => !(s.rrule && s.rollingIntervalDays),
    {
      message:
        "A schedule can be calendar-anchored (rrule) or rolling, not both",
      path: ["rrule"],
    },
  )
  .refine(
    (s) =>
      s.scheduleType !== "CYCLIC" ||
      (s.cyclicOnWeeks !== undefined && s.cyclicOffWeeks !== undefined),
    {
      message: "cyclic schedules require both cyclicOnWeeks and cyclicOffWeeks",
      path: ["cyclicOnWeeks"],
    },
  )
  .refine(
    (s) =>
      s.scheduleType !== "PRN" ||
      (s.rrule === undefined && s.rollingIntervalDays === undefined),
    {
      message:
        "PRN schedules cannot carry a cadence (rrule or rollingIntervalDays)",
      path: ["scheduleType"],
    },
  )
  .refine(
    (s) =>
      s.rollingIntervalDays === undefined ||
      s.rollingIntervalDays === null ||
      !s.timesOfDay ||
      s.timesOfDay.length <= 1,
    {
      message: "rolling-cadence schedules accept at most one time of day",
      path: ["timesOfDay"],
    },
  )
  .refine(
    (s) => {
      // Every per-dose window must name a real dose time. The effective dose
      // times are `timesOfDay` when set, else the single legacy `windowStart`
      // (mirrors the engine's `effectiveTimesOfDay`).
      if (!s.doseWindows || s.doseWindows.length === 0) return true;
      const times = new Set(
        s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay : [s.windowStart],
      );
      return s.doseWindows.every((w) => times.has(w.timeOfDay));
    },
    {
      message: "Each doseWindows.timeOfDay must match one of the schedule's timesOfDay",
      path: ["doseWindows"],
    },
  )
  .refine(
    (s) => {
      // A dose time may carry at most one explicit window.
      if (!s.doseWindows || s.doseWindows.length === 0) return true;
      const seen = new Set<string>();
      for (const w of s.doseWindows) {
        if (seen.has(w.timeOfDay)) return false;
        seen.add(w.timeOfDay);
      }
      return true;
    },
    {
      message: "doseWindows must not repeat a timeOfDay",
      path: ["doseWindows"],
    },
  )
  .meta({
    id: "MedicationScheduleInput",
    description:
      "Single schedule entry on a medication. v1.5 introduces `timesOfDay`, `rrule`, `rollingIntervalDays`, and `reminderGraceMinutes` as first-class fields; `windowStart`, `windowEnd`, `daysOfWeek`, and `intervalWeeks` are preserved through the v1.5.x line for backwards compatibility. **`rrule` and `rollingIntervalDays` are mutually exclusive** — supplying both fails 422 (`rrule_xor_rolling`). The DB enforces the same invariant via a CHECK constraint.",
  });

/**
 * v1.5 — medication-level course window + one-shot flag. The fields
 * are optional on the create path so the existing form (no wizard
 * yet) keeps working. The route layer enforces the `oneShot` + at-
 * least-one-schedule invariant for the wizard path.
 */
const courseWindowFields = {
  /**
   * Date the medication course begins. ISO YYYY-MM-DD. NULL = "from
   * creation" (the legacy implicit anchor).
   */
  startsOn: z.iso
    .date()
    .transform((s) => new Date(s))
    .nullable()
    .optional()
    .describe(
      "Date the medication course begins (ISO `YYYY-MM-DD`). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL = active from creation (the legacy implicit behaviour). Required when `oneShot` is true.",
    ),
  /**
   * Date the medication course ends. ISO YYYY-MM-DD. NULL = chronic.
   * Required to equal `startsOn` when `oneShot` is true (the route
   * normalises this; the schema doesn't because they're sister
   * fields and the cross-field refine is enforced at the route).
   */
  endsOn: z.iso
    .date()
    .transform((s) => new Date(s))
    .nullable()
    .optional()
    .describe(
      "Date the medication course ends (ISO `YYYY-MM-DD`). NULL = no end date (chronic). When `oneShot` is true the route normalises `endsOn` to equal `startsOn`.",
    ),
  /**
   * Single-administration medication. Auto-deactivates after the
   * single intake is logged.
   */
  oneShot: z
    .boolean()
    .optional()
    .describe(
      "Single-administration medication (e.g. flu shot, post-op single dose). When true the medication has at most one schedule with no `rrule` / `rollingIntervalDays`, and `active` auto-flips to false once the dose is logged (non-skipped).",
    ),
  /**
   * v1.16.11 (#316) — as-needed (PRN) medication. No fixed schedule:
   * never due, never reminded, excluded from compliance, active
   * indefinitely. Intakes log ad-hoc and consume inventory. Carries
   * ZERO schedules — a `schedules` array alongside `asNeeded: true` is
   * a 422. Mutually exclusive with `oneShot`.
   */
  asNeeded: z
    .boolean()
    .optional()
    .describe(
      "As-needed (PRN) medication (pain relief, rescue inhaler). When true the medication carries NO schedules (supplying any schedule entry is a 422): it is never due, never reminded, and excluded from compliance rates/streaks, but intakes still log (ad-hoc), inventory still consumes, and the history renders. Stays active indefinitely. Mutually exclusive with `oneShot`.",
    ),
};

/**
 * v1.16.11 — shared as-needed cross-field refines for the create +
 * update bodies: `asNeeded` and `oneShot` are mutually exclusive, and
 * an as-needed medication cannot carry schedule entries.
 */
const AS_NEEDED_ONE_SHOT_MESSAGE =
  "asNeeded and oneShot are mutually exclusive";
const AS_NEEDED_SCHEDULES_MESSAGE =
  "An as-needed medication cannot carry schedules";

export const createMedicationSchema = z
  .object({
    name: z.string().min(1).max(100),
    dose: z.string().min(1).max(50),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    /** v1.4.25 W4d — treatment-class discriminator (GENERIC | GLP1). */
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    /** v1.4.25 W4d — doses per pen/vial for inventory tracking.
     *  v1.16.10 raises the cap to 1000 (large tablet packs). */
    dosesPerUnit: z.number().int().min(1).max(1000).optional(),
    /**
     * v1.16.10 — inventory units one dose consumes (2 × 2 mg tablets
     * for a 4 mg dose). Default 1. Dose-level readouts divide the
     * unit counts by this factor.
     */
    unitsPerDose: z
      .number()
      .refine(isSupportedUnitsPerDose, { message: UNITS_PER_DOSE_MESSAGE })
      .optional()
      .describe(
        "Inventory units consumed per dose. A whole number 1–100 (e.g. 2 tablets of 2 mg for a 4 mg dose) or a supported fraction for a split pill (¼ / ⅓ / ½ / ⅔ / ¾). Default 1. The intake consumption hook decrements this many units per taken dose; dose-derived readouts divide unit counts by it.",
      ),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    /**
     * v1.8.5 — per-medication injection-site tracking opt-in. Default
     * false. Only meaningful when `deliveryForm === "INJECTION"`.
     */
    trackInjectionSites: z
      .boolean()
      .optional()
      .describe(
        "Per-medication injection-site tracking opt-in. Default false. Only meaningful for an INJECTION delivery form; when true the client prompts (skippably) for the site after a taken dose.",
      ),
    /**
     * v1.8.5 — per-medication allowed / preferred injection sites.
     * Empty = no per-medication restriction. The effective pickable set
     * subtracts the user's global exclusion (deny wins).
     */
    allowedInjectionSites: z
      .array(injectionSiteEnum)
      .max(INJECTION_SITE_VALUES.length)
      .optional()
      .describe(
        "Per-medication allowed / preferred injection sites. Empty array = no per-medication restriction (every site offered). The effective pickable set is this list minus the user's global exclusion.",
      ),
    notificationsEnabled: z.boolean().optional(),
    /** v1.7.0 — iOS Live Activity opt-in for this medication's reminders. */
    liveActivityEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    /** v1.7.0 — iOS 26 AlarmKit critical-reminder opt-in. */
    criticalAlarmEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only and hangs no server-side behaviour off it.",
      ),
    /** v1.9.0 — optional WHO ATC classification code. */
    atcCode: atcCodeField,
    /** v1.9.0 — optional RxNorm RxCUI (secondary, US). */
    rxNormCode: rxNormCodeField,
    ...courseWindowFields,
    /**
     * v1.16.11 — optional at the type level so an `asNeeded: true`
     * create can omit it; the refine below keeps the legacy
     * at-least-one-schedule contract for every scheduled medication.
     */
    schedules: z.array(scheduleSchema).optional(),
  })
  .refine((b) => b.oneShot !== true || !!b.startsOn, {
    message: "startsOn is required when oneShot is true",
    path: ["startsOn"],
  })
  .refine(
    (b) =>
      !b.startsOn || !b.endsOn || b.endsOn.getTime() >= b.startsOn.getTime(),
    {
      message: "endsOn must be on or after startsOn",
      path: ["endsOn"],
    },
  )
  .refine((b) => !(b.asNeeded === true && b.oneShot === true), {
    message: AS_NEEDED_ONE_SHOT_MESSAGE,
    path: ["asNeeded"],
  })
  .refine(
    (b) =>
      b.asNeeded === true || (!!b.schedules && b.schedules.length >= 1),
    {
      message: "Mindestens ein Zeitfenster",
      path: ["schedules"],
    },
  )
  .refine(
    (b) =>
      b.asNeeded !== true || !b.schedules || b.schedules.length === 0,
    {
      message: AS_NEEDED_SCHEDULES_MESSAGE,
      path: ["schedules"],
    },
  )
  .meta({
    id: "CreateMedicationRequest",
    description:
      "Create-medication body. The route enforces the v1.5 cross-field invariants on top of the per-schedule `rrule_xor_rolling` Zod refine: a `oneShot:true` medication may carry at most one schedule and that schedule must not declare a recurrence; `endsOn` is normalised to equal `startsOn` for one-shot doses; a recurring schedule with no `rrule`, `rollingIntervalDays`, or legacy `daysOfWeek` defaults to `rrule = \"FREQ=DAILY\"`; and `timesOfDay` is dual-written from `windowStart` when the caller omits it. v1.16.11 — `asNeeded: true` creates a PRN medication with ZERO schedules (`schedules` must be absent or empty, 422 otherwise); a scheduled medication still requires at least one schedule entry.",
  });

export const updateMedicationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    dose: z.string().min(1).max(50).optional(),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    dosesPerUnit: z.number().int().min(1).max(1000).nullable().optional(),
    /** v1.16.10 — inventory units one dose consumes. Default 1.
     *  v1.16.12 — whole number 1–100 or a curated fraction (½ / ⅓ / ¼ …). */
    unitsPerDose: z
      .number()
      .refine(isSupportedUnitsPerDose, { message: UNITS_PER_DOSE_MESSAGE })
      .optional()
      .describe(
        "Inventory units consumed per dose — a whole number 1–100 or a supported split-pill fraction (¼ / ⅓ / ½ / ⅔ / ¾). The intake consumption hook decrements this many units per taken dose; already-stamped intake events keep their recorded consumption.",
      ),
    /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
    deliveryForm: z.enum(MEDICATION_DELIVERY_FORM_VALUES).optional(),
    /** v1.8.5 — per-medication injection-site tracking opt-in. */
    trackInjectionSites: z
      .boolean()
      .optional()
      .describe(
        "Per-medication injection-site tracking opt-in. Only meaningful for an INJECTION delivery form. Set false to deactivate tracking.",
      ),
    /** v1.8.5 — per-medication allowed / preferred injection sites. */
    allowedInjectionSites: z
      .array(injectionSiteEnum)
      .max(INJECTION_SITE_VALUES.length)
      .optional()
      .describe(
        "Per-medication allowed / preferred injection sites. Empty array clears the restriction. The effective pickable set subtracts the user's global exclusion (deny wins).",
      ),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    /** v1.7.0 — iOS Live Activity opt-in for this medication's reminders. */
    liveActivityEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS Live Activity opt-in for this medication's reminders. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    /** v1.7.0 — iOS 26 AlarmKit critical-reminder opt-in. */
    criticalAlarmEnabled: z
      .boolean()
      .optional()
      .describe(
        "iOS 26 AlarmKit critical-reminder opt-in. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    /** v1.9.0 — optional WHO ATC classification code. */
    atcCode: atcCodeField,
    /** v1.9.0 — optional RxNorm RxCUI (secondary, US). */
    rxNormCode: rxNormCodeField,
    ...courseWindowFields,
    schedules: z.array(scheduleSchema).optional(),
    /**
     * v1.5.5 — top-level primary-schedule grace bridge. The detail
     * page settings section saves the reminder-window in minutes for
     * the medication's primary schedule without re-sending the full
     * `schedules` array. The route normalises this value onto the
     * primary schedule's `reminderGraceMinutes` before the Prisma
     * update so the persisted shape stays per-schedule. NULL clears
     * the override and falls back to the legacy `windowEnd -
     * windowStart` span.
     */
    reminderGraceMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable()
      .optional()
      .describe(
        "Detail-page bridge: primary-schedule reminder-window in minutes. The route maps the value onto the primary schedule's `reminderGraceMinutes` field; ignored when a full `schedules` array is also supplied.",
      ),
  })
  .refine((b) => b.oneShot !== true || !!b.startsOn, {
    message: "startsOn is required when oneShot is true",
    path: ["startsOn"],
  })
  .refine(
    (b) =>
      !b.startsOn || !b.endsOn || b.endsOn.getTime() >= b.startsOn.getTime(),
    {
      message: "endsOn must be on or after startsOn",
      path: ["endsOn"],
    },
  )
  .refine((b) => !(b.asNeeded === true && b.oneShot === true), {
    message: AS_NEEDED_ONE_SHOT_MESSAGE,
    path: ["asNeeded"],
  })
  .refine(
    (b) =>
      b.asNeeded !== true || !b.schedules || b.schedules.length === 0,
    {
      message: AS_NEEDED_SCHEDULES_MESSAGE,
      path: ["schedules"],
    },
  )
  .refine(
    // An empty replace-list is only legal on the as-needed path — for a
    // scheduled medication it would wipe every schedule and strand the
    // row in a state no surface can reason about.
    (b) => b.asNeeded === true || !b.schedules || b.schedules.length >= 1,
    {
      message: "Mindestens ein Zeitfenster",
      path: ["schedules"],
    },
  )
  .meta({
    id: "UpdateMedicationRequest",
    description:
      "Update-medication body. Every field is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false records the current timestamp on `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match the create path. v1.16.11 — `asNeeded: true` requires the medication to end schedule-less: supply `schedules: []` to clear an existing plan (any schedule entry is a 422); an empty `schedules` array without `asNeeded: true` is likewise a 422.",
  });

export const intakeSchema = z
  .object({
    medicationId: z
      .string()
      .min(1)
      .describe(
        "Server-narrowed from the URL path. The route layer overwrites whatever the body supplies before Zod parsing so a caller cannot log an intake against another medication.",
      ),
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Slot the dose belongs to. Defaults to `takenAt` (or `now()` when both are absent) so the compliance pairing logic can pin the dose to a schedule slot.",
      ),
    takenAt: boundedTakenAtSchema
      .optional()
      .describe(
        "When the dose was actually taken. NULL when `skipped` is true; defaults to `now()` for non-skipped intakes. Must not lie in the future (5-minute clock-skew allowance) nor more than 5 years in the past.",
      ),
    skipped: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "True to log a skipped slot (no consumption, no inventory decrement, one-shot medications stay active).",
      ),
    idempotencyKey: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Caller-issued de-dup key. A second POST with the same key returns the original event without creating a new row.",
      ),
    /**
     * v1.8.5 — optional injection-site capture. Only honoured on a
     * non-skipped (taken) write for a medication with
     * `deliveryForm === "INJECTION"` and `trackInjectionSites === true`.
     * The site is validated server-side against the medication's
     * effective allowed set (per-medication `allowedInjectionSites`
     * minus the user's `globalExcludedInjectionSites` deny-list); a
     * disallowed value is rejected with 422. Always optional — the
     * client may omit it (the dose still records).
     */
    injectionSite: injectionSiteEnum
      .optional()
      .describe(
        "Optional injection site for a taken dose. Honoured only when the medication is an INJECTION with site-tracking enabled; validated against the medication's effective allowed set (per-medication allowed sites minus the user's global exclusion). A disallowed site returns 422. Omit to record the dose without a site.",
      ),
    /**
     * v1.15.18 — late-take "attribute anyway" pin. An off-window take that
     * band attribution would otherwise orphan to an ad-hoc row can be pinned
     * onto a chosen scheduled slot via the UI's "diesem Slot zuordnen?" nudge.
     * The instant MUST be a real slot of this medication on its day (the
     * server validates it against the band anchors); an arbitrary instant is
     * rejected with 422. Absent → default band attribution.
     */
    forceSlotInstant: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Late-take override: pin this taken dose onto the named scheduled slot instead of orphaning it to an ad-hoc row. Must be a real scheduled slot of this medication on its day (validated server-side against the dose-window band anchors); an instant that is not a slot returns 422. Absent applies the default window-band attribution.",
      ),
    /**
     * v1.16.4 — per-intake dose override. Free text mirroring
     * `Medication.dose` (max 50 chars). Persisted only on a taken
     * (non-skipped) write. Absent = the configured medication dose
     * applies; read paths fall back to it.
     */
    doseTaken: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Dose actually consumed for THIS intake when it deviates from (or documents) the medication's configured dose, e.g. a half tablet or a titration step. Free text, max 50 characters. Omit to record the take under the medication's configured dose.",
      ),
  })
  .meta({
    id: "MedicationIntakeRequest",
    description:
      "Per-medication intake log body. Idempotent via `idempotencyKey`; the server also dedupes by a 60-second sliding window when the key is absent. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for one-shot medications — flip `active` to false. The optional `injectionSite` is persisted only for an INJECTION medication with site-tracking enabled and is validated against the medication's effective allowed set (422 on a disallowed value).",
  });

export const externalIntakeSchema = z.object({
  medicationName: z.string().min(1).max(200),
  // v1.16.9 — same plausibility bounds as the interactive create paths.
  takenAt: boundedTakenAtSchema.optional(),
  idempotencyKey: z.string().max(128),
});

export const listIntakeEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["scheduledFor", "takenAt", "source", "createdAt"])
    .optional()
    .default("scheduledFor"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  /**
   * v1.4.37 W3 — server-side status filter so the medication detail
   * page (IntakeHistoryListV2) can hide unconfirmed / planned rows.
   *
   *  - "all" (default): every event, preserves the byte-stable contract
   *    the iOS Swift client and existing dashboard consumers depend on.
   *  - "taken": only rows where the dose was confirmed taken
   *    (`takenAt IS NOT NULL AND skipped = false`).
   *  - "skipped": only rows the user explicitly skipped (`skipped = true`).
   *  - "completed": taken OR skipped — anything the user actually
   *    actioned. Excludes the ambiguous "missed / never confirmed"
   *    rows (`takenAt IS NULL AND skipped = false`) that the v1 list
   *    rendered as "verpasst" before the v1 component retired.
   */
  status: z
    .enum(["all", "taken", "skipped", "completed"])
    .optional()
    .default("all"),
});

/**
 * v1.15.19 — `takenAt` plausibility bounds on the edit path (audit P0-4).
 * A date typo on an intake edit could park `takenAt` a month before its
 * slot with no pushback anywhere. The schema rejects the physically
 * implausible cases: a future instant (small skew allowance for client
 * clocks) and anything older than the 5-year window the GLP-1 dose-change
 * validator already established (`glp1DoseChangePostSchema`). Slot-distance
 * checks stay out of the schema — it cannot see the medication — and live
 * in the route (start-date guard) + the edit dialog (non-blocking hint).
 */
export const updateIntakeEventSchema = z
  .object({
    takenAt: boundedTakenAtSchema.nullable().optional(),
    skipped: z.boolean().optional(),
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
    /**
     * v1.15.18 — late-take "attribute anyway" pin on the edit path. When the
     * edited `takenAt` lands outside every window the UI can offer to pin the
     * take onto a chosen slot; the server validates the instant is a real
     * scheduled slot (422 otherwise). Absent → the edit re-runs band
     * attribution on the new `takenAt`.
     *
     * v1.15.20 — an explicit `null` UNPINS: the dose re-attributes by window
     * band on its (unchanged or edited) `takenAt` and the binding provenance
     * resets to AUTO — the "Zuordnung lösen" path. A pin / unpin no longer
     * requires `takenAt` or `skipped` to change in the same request.
     */
    forceSlotInstant: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .nullable()
      .optional()
      .describe(
        "Late-take override on edit: pin the edited dose onto the named scheduled slot instead of re-attributing by window band. Must be a real scheduled slot of this medication on its day (validated server-side); a non-slot instant returns 422. Explicit null unpins: the dose re-attributes by window band on its takenAt (ad-hoc when no band matches). Absent re-runs the default window-band attribution on the edited `takenAt`.",
      ),
  })
  .meta({
    id: "UpdateMedicationIntakeEventRequest",
    description:
      "Edit a single intake event. v1.15.18 re-runs window-band slot attribution whenever `takenAt` or `skipped` change, snapping `scheduledFor` to the matched slot (or the take's own time when it falls in no window). `forceSlotInstant` overrides that to pin the take onto a named real slot (explicit null unpins, re-attributing by band); an explicit `scheduledFor` still wins when supplied directly. `takenAt` must not be in the future (5-minute clock-skew allowance) nor more than 5 years in the past; a `takenAt` before the medication's start date returns 422.",
  });

/**
 * v1.5.5 — bulk-delete request body. The detail-page intake-history
 * preview surfaces a multi-select that posts the resulting eventIds
 * here. The cap matches `listIntakeEventsSchema.limit` (500) so the
 * client never selects more rows than the table can return at once.
 * Server-side guarantees scoped-by-medication ownership via
 * `assertMedicationOwnership` + a `userId` predicate on the
 * `deleteMany`.
 */
export const bulkDeleteIntakeEventsSchema = z.object({
  eventIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export type BulkDeleteIntakeEventsInput = z.infer<
  typeof bulkDeleteIntakeEventsSchema
>;

/**
 * v1.4.25 W19b — inventory (pen / vial) CRUD validators.
 *
 * The Prisma model carries a 4-state enum
 * (ACTIVE | IN_USE | EXPIRED | USED_UP); the API surface only lets
 * the user explicitly transition into IN_USE (mark-as-first-use) or
 * USED_UP (manual override). EXPIRED is owned by the daily cron and
 * the intake hook, so the PATCH schema deliberately omits it.
 */
/**
 * v1.16.10 — container kinds, mirrored from the Prisma
 * `MedicationContainerType` enum. Display-level classification only.
 */
export const MEDICATION_CONTAINER_TYPE_VALUES = [
  "PEN",
  "AMPOULE",
  "BLISTER",
  "INHALER",
  "BOTTLE",
  "OTHER",
] as const;
export type MedicationContainerTypeValue =
  (typeof MEDICATION_CONTAINER_TYPE_VALUES)[number];

export const createInventoryItemSchema = z
  .object({
    /** Units the container ships with. v1.16.10 raises the cap from
     *  100 to 1000 (large tablet packs) and renames the wire field to
     *  `unitsTotal` — it counts units, mapped to doses via
     *  `Medication.unitsPerDose`. */
    unitsTotal: z
      .number()
      .min(1)
      .max(1000)
      .describe(
        "Units the container ships with (tablets / ampoules / puffs; 1–1000, fractional allowed for split-pill packs). Dose-derived readouts divide by the medication's `unitsPerDose`.",
      ),
    /** v1.16.10 — container kind. Defaults to OTHER when absent. */
    containerType: z
      .enum(MEDICATION_CONTAINER_TYPE_VALUES)
      .optional()
      .describe(
        "Kind of physical container (PEN / AMPOULE / BLISTER / INHALER / BOTTLE / OTHER). Display-level only; defaults to OTHER.",
      ),
    printedExpiry: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    purchasedAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    notes: z.string().max(200).nullable().optional(),
  })
  .meta({
    id: "CreateMedicationInventoryItemRequest",
    description:
      "Register a new supply container (pen / blister pack / bottle). `unitsTotal` counts UNITS (1–1000); the item starts ACTIVE with `unitsRemaining = unitsTotal` and the intake consumption hook decrements it per taken dose.",
  });

export const updateInventoryItemSchema = z
  .object({
    markAsFirstUseAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Manually start the 30-day in-use clock (the user opened the container without logging an intake). ACTIVE flips to IN_USE; a backdated instant whose window already lapsed lands EXPIRED.",
      ),
    markAsUsedUp: z
      .boolean()
      .optional()
      .describe(
        "Terminal override: zero the remaining units and mark the container USED_UP (physically discarded).",
      ),
    printedExpiry: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    /**
     * v1.16.1 — stock correction (the Bestand tab's adjust / withdraw
     * flow). Sets the remaining-unit count directly; the route clamps to
     * `unitsTotal` and re-runs the canonical state machine (0 ⇒ USED_UP,
     * a raise out of 0 re-evaluates against the expiry clocks).
     * v1.16.10 raises the cap to 1000 alongside the capacity cap and
     * renames the wire field to `unitsRemaining` (it always counted
     * units), matching the response side.
     */
    unitsRemaining: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        "Absolute remaining-unit correction (0–1000, fractional allowed). Clamped server-side to the item's `unitsTotal`; the canonical state machine re-derives the state (0 ⇒ USED_UP).",
      ),
    notes: z.string().max(200).nullable().optional(),
  })
  .meta({
    id: "UpdateMedicationInventoryItemRequest",
    description:
      "Per-item inventory mutation: manual first-use, used-up override, printed-expiry correction, absolute remaining-unit correction, notes. Every field is optional and commutative.",
  });

export type CreateInventoryItemInput = z.infer<
  typeof createInventoryItemSchema
>;
export type UpdateInventoryItemInput = z.infer<
  typeof updateInventoryItemSchema
>;

/**
 * v1.4.25 W21 Fix-K — `POST /api/medications/[id]/glp1` body validators.
 *
 * The convenience route accepts either a `doseChange` or an `inventory`
 * payload (the route picks one). Both branches were hand-rolled
 * `typeof === "number"` checks pre-Fix-K, which let `NaN`, `Infinity`,
 * negative doses, and unbounded notes slip through.
 *
 * Bounds:
 * - `doseValue` is finite, non-negative, capped at 100 mg (covers every
 *   real-world GLP-1 step with headroom).
 * - `doseUnit` is a short string (mg / mcg / IE).
 * - `note` is capped at 500 characters so the field can't be used as a
 *   blob smuggler.
 * - `effectiveFrom` is constrained to a ±5-year window around now —
 *   a paper-record back-fill or a planned future step both fit, but
 *   "1970" / "9999" do not.
 * - `delta` is a non-zero finite integer in [−100, 100] — the legacy
 *   ledger counts pens, and ±100 pens per correction stays plenty
 *   (deliberately NOT raised with the v1.16.10 per-item unit cap).
 * - `reason` is a bounded string (the route logs it; raw blob bad).
 */
const MAX_DOSE_MG = 100;
const MAX_NOTE_CHARS = 500;
const MAX_REASON_CHARS = 200;
const MIN_EFFECTIVE_FROM = new Date("2020-01-01T00:00:00Z");
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export const glp1DoseChangePostSchema = z.object({
  effectiveFrom: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() >= MIN_EFFECTIVE_FROM.getTime(), {
      message: "effectiveFrom must be on or after 2020-01-01",
    })
    .refine((d) => d.getTime() <= Date.now() + FIVE_YEARS_MS, {
      message: "effectiveFrom must be within 5 years of now",
    }),
  doseValue: z.number().finite().min(0).max(MAX_DOSE_MG),
  doseUnit: z.string().min(1).max(10),
  note: z.string().max(MAX_NOTE_CHARS).nullable().optional(),
});

/**
 * DEPRECATED write path (v1.16.10) — the `inventory.delta` branch feeds
 * the legacy `MedicationInventoryEvent` running-sum ledger. The per-item
 * endpoints (`POST /api/medications/[id]/inventory`,
 * `PATCH /api/medications/[id]/inventory/[itemId]`) replaced it; reads
 * fall back to the ledger only while a medication has zero inventory
 * items. New callers must register containers instead of posting deltas.
 */
export const glp1InventoryPostSchema = z.object({
  delta: z
    .number()
    .int()
    .finite()
    .min(-100)
    .max(100)
    .refine((n) => n !== 0, { message: "delta must be non-zero" })
    .describe(
      "Deprecated since v1.16.10: pen-count delta on the legacy running-sum ledger. Register containers via the inventory endpoints instead; reads use the ledger only while the medication has no inventory items.",
    ),
  reason: z.string().min(1).max(MAX_REASON_CHARS),
});

export const glp1PostBodySchema = z
  .object({
    doseChange: glp1DoseChangePostSchema.optional(),
    inventory: glp1InventoryPostSchema.optional(),
  })
  .refine((b) => Boolean(b.doseChange) !== Boolean(b.inventory), {
    message: "Body must carry exactly one of doseChange or inventory",
  });

export type Glp1DoseChangePostInput = z.infer<typeof glp1DoseChangePostSchema>;
export type Glp1InventoryPostInput = z.infer<typeof glp1InventoryPostSchema>;
export type Glp1PostBodyInput = z.infer<typeof glp1PostBodySchema>;

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
export type ListIntakeEventsInput = z.infer<typeof listIntakeEventsSchema>;
export type UpdateIntakeEventInput = z.infer<typeof updateIntakeEventSchema>;
