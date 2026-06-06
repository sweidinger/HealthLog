/**
 * Cycle-tracking request/response validation (v1.15.0).
 *
 * Source of truth for the `/api/cycle/*` wire contract (ios-contract §2).
 * The Zod schemas here are reused by the OpenAPI registry so the spec
 * stays single-source. `userId` is NEVER a body field — it is narrowed
 * from the session/Bearer in every route.
 *
 * Dates are `YYYY-MM-DD` strings (the MoodEntry tz-anchored convention);
 * instants are ISO-8601 with offset.
 */
import { z } from "zod/v4";

/* ── enums (mirror the Prisma enums) ─────────────────────────────── */

export const flowLevelEnum = z.enum([
  "NONE",
  "SPOTTING",
  "LIGHT",
  "MEDIUM",
  "HEAVY",
]);

export const ovulationTestEnum = z.enum([
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
]);

export const cervicalMucusEnum = z.enum([
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
]);

export const homeTestResultEnum = z.enum([
  "NEGATIVE",
  "POSITIVE",
  "INDETERMINATE",
]);

export const contraceptiveKindEnum = z.enum([
  "NONE",
  "UNSPECIFIED",
  "IMPLANT",
  "INJECTION",
  "IUD",
  "INTRAVAGINAL_RING",
  "ORAL",
  "PATCH",
  "EMERGENCY",
]);

export const cycleTrackingGoalEnum = z.enum([
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
]);

/**
 * Day-log source. MANUAL (web / single POST) or APPLE_HEALTH (the
 * HealthKit batch ingest). Mirrors `MeasurementSource`; the wire spelling
 * is APPLE_HEALTH, not "HEALTHKIT".
 */
export const cycleSourceEnum = z.enum(["MANUAL", "APPLE_HEALTH"]);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/* ── day-log capture (single + bulk shared input) ────────────────── */

/**
 * The canonical day-log input. Shared by the single POST, the PATCH, and
 * the bulk drain. `note` is encrypted at rest (`notesEncrypted`); every
 * other field is queryable plaintext (feeds rollups / correlation).
 */
export const cycleDayLogInputSchema = z.object({
  date: dateString,
  flow: flowLevelEnum.optional(),
  intermenstrualBleeding: z.boolean().optional(),
  basalBodyTempC: z.number().min(30).max(45).optional(),
  ovulationTest: ovulationTestEnum.optional(),
  cervicalMucus: cervicalMucusEnum.optional(),
  sexualActivity: z.boolean().optional(),
  protectedSex: z.boolean().nullable().optional(),
  pregnancyTest: homeTestResultEnum.optional(),
  progesteroneTest: homeTestResultEnum.optional(),
  contraceptive: contraceptiveKindEnum.optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        severity: z.number().int().min(1).max(4).optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(500).optional(),
  loggedAt: z.iso.datetime({ offset: true }),
  source: cycleSourceEnum.optional().default("MANUAL"),
  externalId: z.string().min(1).max(120).optional(),
});

export type CycleDayLogInput = z.infer<typeof cycleDayLogInputSchema>;

/** PATCH body — every field optional; `date`/`source`/`externalId` are immutable on update. */
export const cycleDayLogPatchSchema = z.object({
  flow: flowLevelEnum.nullable().optional(),
  intermenstrualBleeding: z.boolean().optional(),
  basalBodyTempC: z.number().min(30).max(45).nullable().optional(),
  ovulationTest: ovulationTestEnum.nullable().optional(),
  cervicalMucus: cervicalMucusEnum.nullable().optional(),
  sexualActivity: z.boolean().optional(),
  protectedSex: z.boolean().nullable().optional(),
  pregnancyTest: homeTestResultEnum.nullable().optional(),
  progesteroneTest: homeTestResultEnum.nullable().optional(),
  contraceptive: contraceptiveKindEnum.nullable().optional(),
  symptoms: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        severity: z.number().int().min(1).max(4).optional(),
      }),
    )
    .max(40)
    .optional(),
  note: z.string().max(500).nullable().optional(),
  loggedAt: z.iso.datetime({ offset: true }).optional(),
});

export const MAX_CYCLE_BULK_ENTRIES = 500;

export const cycleBulkSchema = z.object({
  entries: z.array(cycleDayLogInputSchema).min(1).max(MAX_CYCLE_BULK_ENTRIES),
});

/* ── period-boundary shortcut ────────────────────────────────────── */

export const cyclePeriodSchema = z.object({
  action: z.enum(["start", "end"]),
  date: dateString,
  externalId: z.string().min(1).max(120).optional(),
  loggedAt: z.iso.datetime({ offset: true }),
});

/* ── calendar + history queries ──────────────────────────────────── */

export const cycleCalendarQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const cycleHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

/* ── cycle preferences (PATCH /api/auth/me/cycle-prefs) ──────────── */

/**
 * Partial deep-merge body for the cycle-prefs PATCH. Mirrors the
 * notification-prefs precedent: an omitted field is left untouched.
 */
export const cyclePrefsSchema = z
  .object({
    enabled: z.boolean().optional(),
    goal: cycleTrackingGoalEnum.optional(),
    rawChartMode: z.boolean().optional(),
    predictionEnabled: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
    typicalCycleLength: z.number().int().min(15).max(60).nullable().optional(),
    typicalPeriodLength: z.number().int().min(1).max(15).nullable().optional(),
    // Bound matches the engine clamp [LUTEAL_MIN, LUTEAL_MAX] (§4) so the
    // stored value never silently snaps in the predictor (QA HIGH).
    lutealPhaseLength: z.number().int().min(10).max(16).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one preference field is required",
  });

export type CyclePrefsInput = z.infer<typeof cyclePrefsSchema>;
