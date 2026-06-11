/**
 * v1.16.5 — request schema for
 * `POST /api/medications/{id}/schedule-revisions`.
 *
 * Lives outside the route file so the OpenAPI registry can import it
 * without dragging `@/lib/db` into the generator script — the same
 * split as `src/lib/validations/invite.ts`.
 *
 * The endpoint appends a MANUAL schedule era ("the medication dosed at
 * 07:00/19:00 from March to June, before I tracked it here"). The body
 * carries the era bounds as instants plus the daily times-of-day the
 * era dosed at; the route derives the snapshot payload entry
 * (`FREQ=DAILY`, window pulled to min/max of the times) so the era
 * minter reads it exactly like a write-path archive.
 */
import { z } from "zod/v4";

/** HH:mm wall-clock literal — mirrors `validations/medication.ts`. */
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const scheduleRevisionCreateSchema = z
  .object({
    /** Inclusive start instant of the manual era. */
    validFrom: z.iso
      .datetime({ offset: true })
      .describe("Inclusive start instant of the manual era (ISO 8601)."),
    /**
     * Exclusive end instant — the moment the next plan took over. Must
     * lie after `validFrom` and at or before the start of the live
     * schedule era (the newest archived revision's `validUntil`, or
     * "now" when no revision exists yet).
     */
    validUntil: z.iso
      .datetime({ offset: true })
      .describe(
        "Exclusive end instant of the manual era (ISO 8601). Must precede the current plan.",
      ),
    /** Daily dose times the era ran at. Same cap as live schedules. */
    timesOfDay: z
      .array(z.string().regex(timeRegex, "Format: HH:mm"))
      .min(1)
      .max(8)
      .describe(
        "Daily dose times (HH:mm, user local) the era ran at. 1–8 entries.",
      ),
  })
  .refine(
    (body) => new Date(body.validFrom).getTime() < new Date(body.validUntil).getTime(),
    {
      message: "validFrom must lie before validUntil",
      path: ["validUntil"],
    },
  )
  .meta({
    id: "CreateScheduleRevisionRequest",
    description:
      "Manual schedule-era payload: era bounds plus the daily dose times that were live during the era.",
  });

export type ScheduleRevisionCreateInput = z.infer<
  typeof scheduleRevisionCreateSchema
>;
