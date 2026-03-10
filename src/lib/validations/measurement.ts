import { z } from "zod/v4";

export const measurementTypeEnum = z.enum([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
]);

export const measurementSourceEnum = z.enum(["MANUAL", "WITHINGS", "IMPORT"]);

const unitMap: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "hours",
  ACTIVITY_STEPS: "steps",
};

export function getUnitForType(type: string): string {
  return unitMap[type] ?? "unknown";
}

// Plausible ranges per measurement type
const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  WEIGHT: { min: 1, max: 500 },
  BLOOD_PRESSURE_SYS: { min: 40, max: 300 },
  BLOOD_PRESSURE_DIA: { min: 20, max: 200 },
  PULSE: { min: 20, max: 300 },
  BODY_FAT: { min: 1, max: 80 },
  SLEEP_DURATION: { min: 0, max: 24 },
  ACTIVITY_STEPS: { min: 0, max: 200000 },
};

export function validateMeasurementRange(
  type: string,
  value: number,
): string | null {
  const range = VALUE_RANGES[type];
  if (range && (value < range.min || value > range.max)) {
    return `Wert muss zwischen ${range.min} und ${range.max} liegen`;
  }
  return null;
}

export const createMeasurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    measuredAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    notes: z
      .string()
      .max(25, "Kommentar darf maximal 25 Zeichen haben")
      .optional(),
    source: measurementSourceEnum.optional().default("MANUAL"),
  })
  .refine(
    (data) => validateMeasurementRange(data.type, data.value) === null,
    "Wert ausserhalb des plausiblen Bereichs",
  );

export const updateMeasurementSchema = z.object({
  value: z.number().min(0).max(500000).optional(),
  measuredAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  notes: z
    .string()
    .max(25, "Kommentar darf maximal 25 Zeichen haben")
    .nullable()
    .optional(),
});

export const listMeasurementsSchema = z.object({
  type: measurementTypeEnum.optional(),
  from: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["type", "value", "measuredAt", "source"])
    .optional()
    .default("measuredAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const createBatchMeasurementSchema = z.object({
  measurements: z.array(createMeasurementSchema).min(1).max(5),
});

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type CreateBatchMeasurementInput = z.infer<
  typeof createBatchMeasurementSchema
>;
export type UpdateMeasurementInput = z.infer<typeof updateMeasurementSchema>;
export type ListMeasurementsInput = z.infer<typeof listMeasurementsSchema>;
