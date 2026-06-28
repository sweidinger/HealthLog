/**
 * v1.25 (W-ENV) — environmental-context request validation.
 *
 * The home location, the travel overrides, and the backfill span. Coordinates
 * are bounded to valid lat/lon; the labels are length-capped plaintext (a city
 * name, never a quasi-identifier). Dates are strict YYYY-MM-DD. The shared
 * shapes are reused by the OpenAPI registry so the wire contract stays
 * single-source.
 */
import { z } from "zod/v4";

/** Strict YYYY-MM-DD calendar day. */
export const dayStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

const latSchema = z.number().gte(-90).lte(90);
const lonSchema = z.number().gte(-180).lte(180);
const labelSchema = z.string().trim().min(1).max(200);

/** A coarse home location set in settings (city-level granularity). */
export const homeLocationSchema = z
  .object({
    lat: latSchema,
    lon: lonSchema,
    label: labelSchema,
    /** IANA timezone (anchors the stored day-key). */
    timezone: z.string().trim().min(1).max(64),
  })
  .strict();

export type HomeLocationInput = z.infer<typeof homeLocationSchema>;

/** A manual travel override covering an inclusive date range. */
export const travelLocationSchema = z
  .object({
    startDate: dayStringSchema,
    endDate: dayStringSchema,
    lat: latSchema,
    lon: lonSchema,
    label: labelSchema,
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"],
  });

export type TravelLocationInput = z.infer<typeof travelLocationSchema>;

/** A backfill request: fetch + store the environment rows over a date range. */
export const environmentBackfillSchema = z
  .object({
    startDate: dayStringSchema,
    endDate: dayStringSchema,
  })
  .strict()
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["endDate"],
  });

export type EnvironmentBackfillInput = z.infer<
  typeof environmentBackfillSchema
>;

/** Geocoding search query (`?q=`). */
export const geocodeQuerySchema = z
  .object({ q: z.string().trim().min(1).max(120) })
  .strict();
