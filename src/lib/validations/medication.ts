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
     * v1.15.18 — per-dose configurable on-time intake window (Marc's
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
};

export const createMedicationSchema = z
  .object({
    name: z.string().min(1).max(100),
    dose: z.string().min(1).max(50),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    /** v1.4.25 W4d — treatment-class discriminator (GENERIC | GLP1). */
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    /** v1.4.25 W4d — doses per pen/vial for inventory tracking. */
    dosesPerUnit: z.number().int().min(1).max(100).optional(),
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
    schedules: z.array(scheduleSchema).min(1, "Mindestens ein Zeitfenster"),
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
  .meta({
    id: "CreateMedicationRequest",
    description:
      "Create-medication body. The route enforces the v1.5 cross-field invariants on top of the per-schedule `rrule_xor_rolling` Zod refine: a `oneShot:true` medication may carry at most one schedule and that schedule must not declare a recurrence; `endsOn` is normalised to equal `startsOn` for one-shot doses; a recurring schedule with no `rrule`, `rollingIntervalDays`, or legacy `daysOfWeek` defaults to `rrule = \"FREQ=DAILY\"`; and `timesOfDay` is dual-written from `windowStart` when the caller omits it.",
  });

export const updateMedicationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    dose: z.string().min(1).max(50).optional(),
    category: z.enum(MEDICATION_CATEGORY_VALUES).optional(),
    treatmentClass: z.enum(MEDICATION_TREATMENT_CLASS_VALUES).optional(),
    dosesPerUnit: z.number().int().min(1).max(100).nullable().optional(),
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
  .meta({
    id: "UpdateMedicationRequest",
    description:
      "Update-medication body. Every field is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false records the current timestamp on `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match the create path.",
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
    takenAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "When the dose was actually taken. NULL when `skipped` is true; defaults to `now()` for non-skipped intakes.",
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
  })
  .meta({
    id: "MedicationIntakeRequest",
    description:
      "Per-medication intake log body. Idempotent via `idempotencyKey`; the server also dedupes by a 60-second sliding window when the key is absent. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for one-shot medications — flip `active` to false. The optional `injectionSite` is persisted only for an INJECTION medication with site-tracking enabled and is validated against the medication's effective allowed set (422 on a disallowed value).",
  });

export const externalIntakeSchema = z.object({
  medicationName: z.string().min(1).max(200),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
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

export const updateIntakeEventSchema = z
  .object({
    takenAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
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
     */
    forceSlotInstant: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Late-take override on edit: pin the edited dose onto the named scheduled slot instead of re-attributing by window band. Must be a real scheduled slot of this medication on its day (validated server-side); a non-slot instant returns 422. Absent re-runs the default window-band attribution on the edited `takenAt`.",
      ),
  })
  .meta({
    id: "UpdateMedicationIntakeEventRequest",
    description:
      "Edit a single intake event. v1.15.18 re-runs window-band slot attribution whenever `takenAt` or `skipped` change, snapping `scheduledFor` to the matched slot (or the take's own time when it falls in no window). `forceSlotInstant` overrides that to pin the take onto a named real slot; an explicit `scheduledFor` still wins when supplied directly.",
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
export const createInventoryItemSchema = z.object({
  dosesTotal: z.number().int().min(1).max(100),
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
});

export const updateInventoryItemSchema = z.object({
  markAsFirstUseAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  markAsUsedUp: z.boolean().optional(),
  printedExpiry: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullable()
    .optional(),
  notes: z.string().max(200).nullable().optional(),
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
 * - `delta` is a non-zero finite integer in [−100, 100] (the existing
 *   inventory route caps `dosesTotal` at 100 doses per pen).
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

export const glp1InventoryPostSchema = z.object({
  delta: z
    .number()
    .int()
    .finite()
    .min(-100)
    .max(100)
    .refine((n) => n !== 0, { message: "delta must be non-zero" }),
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
