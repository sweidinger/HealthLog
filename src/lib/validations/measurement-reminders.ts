/**
 * v1.17.1 — Measurement / Vorsorge (preventive-care) reminders.
 *
 * A reminder class distinct from the medication loop: "measure BP every
 * 7 days", "annual blood panel", "log weight weekly". Tied to a
 * measurement TYPE (auto-resolving when a matching reading lands) or to a
 * free-text checklist label (resolving only on a manual "Erledigt").
 *
 * The cadence vocabulary reuses the medication recurrence engine: a
 * `intervalDays` rolling cadence OR an RFC-5545 `rrule`. The server
 * computes the canonical `nextDueAt` so web ↔ iOS show identical numbers
 * (server-authoritative; the client consumes the resolved DTO, never
 * recomputes).
 */
import { z } from "zod/v4";

/**
 * The auto-resolve target types. Kept as an explicit allow-list rather
 * than the full `MeasurementType` enum: a Vorsorge reminder only makes
 * sense for the metrics a user actively goes and measures on a cadence —
 * vitals + the body-composition family a scale produces.
 *
 * v1.18.1 (V3) widens the original 7 to the full ~15 active-measurement
 * set. The DB column is the full `MeasurementType` enum, so this is a
 * pure application-layer change — no migration.
 *
 * DELIBERATELY excluded: passive wearable scores + cumulative activity +
 * device events (RECOVERY_SCORE, ACTIVITY_STEPS, IRREGULAR_RHYTHM_*, …),
 * and the passive nightly samples RESTING_HEART_RATE / HEART_RATE_VARIABILITY
 * / VO2_MAX — nudging a user to "go measure" a passive sample makes no
 * sense (they still auto-satisfy any free-text reminder via a LabResult if
 * ever wanted, but they are not "remind me to measure" targets).
 *
 * BP is matched on `BLOOD_PRESSURE_SYS` as the canonical sentinel — a BP
 * reading is two rows (SYS + DIA) and matching either would double-count;
 * SYS is the agreed "a BP was measured" anchor. A single step-on-the-scale
 * event writes WEIGHT + several body-composition rows at once, so any one
 * of them satisfies its linked reminder.
 */
export const measurementReminderTypeEnum = z
  .enum([
    // Vitals
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "PULSE",
    "BLOOD_GLUCOSE",
    "OXYGEN_SATURATION",
    "BODY_TEMPERATURE",
    // Body composition (one scale reading produces the whole family)
    "BODY_FAT",
    "FAT_MASS",
    "FAT_FREE_MASS",
    "MUSCLE_MASS",
    "LEAN_BODY_MASS",
    "BONE_MASS",
    "TOTAL_BODY_WATER",
    "VISCERAL_FAT",
    "BODY_MASS_INDEX",
  ])
  .meta({
    id: "MeasurementReminderType",
    description:
      "Auto-resolve target metric (vitals + body-composition family). BP resolves on BLOOD_PRESSURE_SYS (the SYS row is the 'a BP was measured' sentinel). Omit for a free-text Vorsorge that resolves only on a manual satisfy or a matching lab result.",
  });

export type MeasurementReminderType = z.infer<
  typeof measurementReminderTypeEnum
>;

/**
 * RFC-5545 RRULE guard. The recurrence engine parses it; here we only
 * bound the length and require the `FREQ=` token so a typo doesn't reach
 * the engine. Full validation is the engine's job (it tolerates a
 * malformed rule by emitting no slots rather than throwing).
 */
const rruleField = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => /FREQ=/i.test(v), {
    message: "rrule must contain a FREQ= component",
  });

/**
 * Shared cadence refinement: exactly one of `intervalDays` / `rrule` is
 * required on create. Both NULL would leave `nextDueAt` uncomputable.
 */
const cadenceRefinement = (
  data: { intervalDays?: number | null; rrule?: string | null },
  ctx: z.RefinementCtx,
): void => {
  const hasInterval =
    data.intervalDays !== undefined && data.intervalDays !== null;
  const hasRrule = data.rrule !== undefined && data.rrule !== null;
  if (!hasInterval && !hasRrule) {
    ctx.addIssue({
      code: "custom",
      message: "Provide either intervalDays or rrule",
      path: ["intervalDays"],
    });
  }
  if (hasInterval && hasRrule) {
    ctx.addIssue({
      code: "custom",
      message: "Provide only one of intervalDays or rrule",
      path: ["rrule"],
    });
  }
};

export const createMeasurementReminderSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    measurementType: measurementReminderTypeEnum.nullish(),
    intervalDays: z.number().int().min(1).max(3650).nullish(),
    rrule: rruleField.nullish(),
    anchorDate: z.iso.datetime({ offset: true }).nullish(),
    notifyHour: z.number().int().min(0).max(23).default(9),
    location: z.string().trim().max(200).nullish(),
    enabled: z.boolean().default(true),
  })
  .superRefine(cadenceRefinement)
  .meta({
    id: "MeasurementReminderCreate",
    description:
      "Create a Vorsorge reminder. Exactly one of intervalDays (rolling, every N days) or rrule (RFC-5545, e.g. FREQ=YEARLY) is required. measurementType enables auto-resolve from an incoming reading; omit it for a free-text checklist reminder.",
  });

export type CreateMeasurementReminderInput = z.infer<
  typeof createMeasurementReminderSchema
>;

/**
 * Update is fully partial. Cadence fields stay mutually-exclusive but
 * are not required (an edit that only changes the label leaves the
 * cadence alone). The route re-derives `nextDueAt` after applying the
 * patch.
 */
export const updateMeasurementReminderSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    measurementType: measurementReminderTypeEnum.nullish(),
    intervalDays: z.number().int().min(1).max(3650).nullish(),
    rrule: rruleField.nullish(),
    anchorDate: z.iso.datetime({ offset: true }).nullish(),
    notifyHour: z.number().int().min(0).max(23).optional(),
    location: z.string().trim().max(200).nullish(),
    enabled: z.boolean().optional(),
  })
  .meta({
    id: "MeasurementReminderUpdate",
    description:
      "Partial edit of a Vorsorge reminder. Omitted fields are left untouched; nextDueAt is recomputed server-side after the patch applies.",
  });

export type UpdateMeasurementReminderInput = z.infer<
  typeof updateMeasurementReminderSchema
>;

/**
 * The canonical DTO every surface (web list, dashboard tile, iOS) mirrors.
 * `nextDueAt` is the server-computed next-due instant.
 */
export const measurementReminderDto = z
  .object({
    id: z.string(),
    label: z.string(),
    measurementType: measurementReminderTypeEnum.nullable(),
    intervalDays: z.number().int().nullable(),
    rrule: z.string().nullable(),
    anchorDate: z.iso.datetime({ offset: true }).nullable(),
    notifyHour: z.number().int(),
    location: z.string().nullable(),
    nextDueAt: z.iso.datetime({ offset: true }).nullable(),
    lastSatisfiedAt: z.iso.datetime({ offset: true }).nullable(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MeasurementReminderDTO",
    description:
      "A Vorsorge reminder. nextDueAt is server-computed (server-authoritative). A free-text reminder carries measurementType=null and resolves only on a manual satisfy.",
  });
