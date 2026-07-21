/**
 * v1.28 — request + response contracts for the medication-efficacy view
 * ("Wirkung"). The response schema mirrors the DTO the server builder emits
 * (`src/lib/medications/efficacy/build-efficacy.ts`) so the OpenAPI wire
 * contract the iOS client consumes stays single-source. Strictly descriptive
 * by construction — there is no verdict / score / assessment field on the DTO.
 */
import { z } from "zod/v4";
import { measurementTypeEnum } from "@/lib/validations/measurement";

/**
 * Set or clear the user's explicit efficacy-target override for a medication.
 * When `clear` is true the override rows are removed and the resolver reverts
 * to the derived (ATC / name) target. Otherwise exactly ONE of
 * `measurementType` (a metric series) / `biomarkerId` (a lab analyte) sets the
 * new target. `userId` is never a body field — it is narrowed from the parent
 * medication's ownership.
 */
export const efficacyTargetOverrideSchema = z
  .object({
    clear: z.boolean().optional(),
    measurementType: measurementTypeEnum.optional(),
    biomarkerId: z.string().trim().min(1).max(64).optional(),
    customMetricId: z.string().trim().min(1).max(64).optional(),
    primary: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.clear === true ||
      [v.measurementType, v.biomarkerId, v.customMetricId].filter(
        (x) => x !== undefined,
      ).length === 1,
    {
      message:
        "Set exactly one of measurementType / biomarkerId / customMetricId, or pass clear:true to revert to the derived target.",
      path: ["measurementType"],
    },
  );

export type EfficacyTargetOverrideInput = z.infer<
  typeof efficacyTargetOverrideSchema
>;

// ── Response DTO schema (OpenAPI mirror of the builder output) ──────────

const seriesPointSchema = z.object({
  t: z.string(),
  value: z.number(),
  status: z.enum(["in-range", "below", "above", "unknown"]).optional(),
});

const beforeAfterSchema = z.object({
  present: z.boolean(),
  reason: z
    .enum(["insufficient_before", "insufficient_after", "no_start", "no_data"])
    .optional(),
  before: z
    .object({
      mean: z.number(),
      count: z.number().int(),
      from: z.string(),
      to: z.string(),
    })
    .optional(),
  after: z
    .object({
      mean: z.number(),
      count: z.number().int(),
      from: z.string(),
      to: z.string(),
    })
    .optional(),
  delta: z
    .object({ mean: z.number(), pct: z.number().nullable() })
    .nullable()
    .optional(),
});

const levelShiftSchema = z
  .object({
    present: z.boolean(),
    at: z.string().optional(),
    nearStart: z.boolean().optional(),
  })
  .nullable();

const targetViewSchema = z.object({
  kind: z.enum(["metric", "lab", "custom"]),
  key: z.string(),
  label: z.string(),
  unit: z.string().nullable(),
  primary: z.boolean(),
  referenceBand: z.object({ low: z.number(), high: z.number() }).nullable(),
  series: z.array(seriesPointSchema),
  beforeAfter: beforeAfterSchema,
  levelShift: levelShiftSchema,
});

export const medicationEfficacyResponseSchema = z.object({
  medicationId: z.string(),
  medicationName: z.string(),
  eligible: z.boolean(),
  reason: z.enum(["one_shot", "no_target"]).optional(),
  startsOn: z.string().nullable(),
  resolution: z.object({
    tier: z.enum(["override", "atc", "name", "none"]),
    cls: z.string().nullable(),
  }),
  windowDays: z.number().int(),
  minWeeksPerSide: z.number().int(),
  markers: z.object({
    start: z.string().nullable(),
    startSource: z.enum(["startsOn", "firstReading"]).nullable(),
    doseChanges: z.array(z.object({ at: z.string(), label: z.string() })),
    pauses: z.array(z.object({ from: z.string(), to: z.string().nullable() })),
  }),
  targets: z.array(targetViewSchema),
  adherence: z.array(
    z.object({
      date: z.string(),
      rate: z.number(),
      taken: z.number().int(),
      missed: z.number().int(),
    }),
  ),
  overrideOptions: z.object({
    metrics: z.array(z.object({ key: z.string(), label: z.string() })),
    biomarkers: z.array(
      z.object({ id: z.string(), label: z.string(), unit: z.string() }),
    ),
    customMetrics: z.array(
      z.object({ id: z.string(), label: z.string(), unit: z.string() }),
    ),
  }),
});

export type MedicationEfficacyResponse = z.infer<
  typeof medicationEfficacyResponseSchema
>;
