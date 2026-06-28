/**
 * v1.25 — request/response validation for the opt-in mental-health screeners
 * (PHQ-9 / GAD-7). The item answers are 0–3 integers; the array length must
 * match the instrument (PHQ-9 = 9, GAD-7 = 7). `userId` is NEVER a body field —
 * it is narrowed from the session in the handler (CLAUDE.md convention).
 */
import { z } from "zod/v4";
import {
  INSTRUMENTS,
  type InstrumentId,
} from "@/lib/mental-health/instruments";

export const assessmentInstrumentEnum = z.enum(["PHQ9", "GAD7"]);

const itemAnswer = z.number().int().min(0).max(3);

export const createAssessmentSchema = z
  .object({
    instrument: assessmentInstrumentEnum,
    /** Per-item answers, each 0–3, ordered as the instrument presents them. */
    items: z.array(itemAnswer).min(1).max(12),
    /** Optional functional-impairment follow-up (not scored into the total). */
    functionalDifficulty: z.number().int().min(0).max(3).optional(),
    /** ISO instant the screener was taken; defaults to now server-side. */
    takenAt: z.string().datetime().optional(),
    tz: z.string().max(64).optional(),
    /** Locale of the validated wording actually presented. */
    locale: z.string().max(16).optional(),
  })
  .superRefine((val, ctx) => {
    const def = INSTRUMENTS[val.instrument as InstrumentId];
    if (val.items.length !== def.itemCount) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `${val.instrument} expects exactly ${def.itemCount} item answers`,
      });
    }
  });

export const listAssessmentsSchema = z.object({
  instrument: assessmentInstrumentEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;
