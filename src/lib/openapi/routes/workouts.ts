/**
 * OpenAPI route table — workouts list/detail/batch.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { measurementSourceEnum } from "@/lib/validations/measurement";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.4.25 W16b — typed workout batch ingest response envelope. Mirrors
// the measurements batch shape but reports the `workouts` count rather
// than the entries count, and the `skipped` field is reserved (the
// Zod schema rejects malformed entries with a 400 before the per-entry
// pass, so today's responses always carry an empty array).
const workoutBatchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "WorkoutBatchEntryResult" });

const workoutBatchResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(workoutBatchEntryResult),
  })
  .meta({ id: "WorkoutBatchResponse" });

// v1.4.32 — workout list / detail wire shape. The field names follow
// the iOS handoff contract (`distanceM` + `activeEnergyKcal`) rather
// than the Prisma column names so iOS and web consumers share one
// JSON envelope.
const workoutListEntry = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
  })
  .meta({ id: "WorkoutListEntry" });

const workoutListResponse = z
  .object({
    workouts: z.array(workoutListEntry),
    meta: z.object({
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      droppedDuplicates: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: "WorkoutListResponse" });

const workoutRouteGeometry = z
  .object({
    geometry: z.unknown(),
    sampleTimestamps: z.array(z.string()).nullable(),
  })
  .meta({ id: "WorkoutRouteGeometry" });

// v1.10.0 — route-independent per-workout heart-rate series. Present
// for indoor and outdoor workouts that shipped a `samples` array on
// ingest. `samples` mirrors the ingest shape `[{ t, hr?, speedMs?,
// power?, cadence? }]`; `sampleCount` is the denormalised length.
const workoutHrSeries = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    samples: z.unknown(),
  })
  .meta({ id: "WorkoutHrSeries" });

const workoutDetailResponse = z
  .object({
    id: z.string(),
    sportType: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().nullable(),
    activeEnergyKcal: z.number().nullable(),
    avgHr: z.number().int().nullable(),
    maxHr: z.number().int().nullable(),
    minHr: z.number().int().nullable(),
    stepCount: z.number().int().nullable(),
    elevationM: z.number().nullable(),
    pauseDurationSec: z.number().int().nullable(),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    metadata: z.unknown().nullable(),
    route: workoutRouteGeometry.nullable(),
    samples: workoutHrSeries.nullable(),
    canonicalId: z.string(),
  })
  .meta({ id: "WorkoutDetailResponse" });

export const workoutPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/workouts": {
    get: {
      tags: ["Measurements"],
      summary: "List workouts (v1.4.32)",
      description:
        "Paginated workout list with cross-source canonical-row dedup. The picker reads the per-user source-priority ladder and buckets by `(startedAt 5 min slot, sportType)` — twin workouts (Apple Watch + Withings ScanWatch) collapse to a single canonical row per cluster. Field names mirror the iOS handoff contract: `distanceM`, `activeEnergyKcal`, `avgHr`, `maxHr`.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          since: z.iso.datetime({ offset: true }).optional(),
          until: z.iso.datetime({ offset: true }).optional(),
          sportType: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Canonical workout page.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutListResponse, "ListWorkoutsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/workouts/{id}": {
    get: {
      tags: ["Measurements"],
      summary: "Workout detail (v1.4.32)",
      description:
        "Single-workout envelope. Owns the optional `WorkoutRoute` GeoJSON geometry + `canonicalId` pointer that resolves to the cluster winner so deep-links into non-canonical twin rows can redirect cleanly. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Workout detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(workoutDetailResponse, "GetWorkoutResponse"),
            },
          },
        },
        "404": {
          description: "Workout not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/workouts/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Typed workout batch ingest (v1.4.25 W16b)",
      description:
        "Server-side ingest endpoint for HKWorkout records (iOS) and Withings activity rows (server-to-server). Up to 100 workouts per call; nested route geometry (GeoJSON LineString) is capped at 20 000 points and stored in a 1:1 `WorkoutRoute` row keyed by `workoutId`. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status (`inserted | duplicate | skipped`) lets the iOS sync cursor checkpoint accurately. The request body ceiling is 5 MB enforced at the HTTP layer — clients above the ceiling receive a 413 with `workout.batch.payload_too_large`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBatchWorkoutSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                workoutBatchResponse,
                "BatchWorkoutsResponse",
              ),
            },
          },
        },
        "400": {
          description:
            "Batch validation failed (over-cap, schema reject, or oversized route).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 5 MB ceiling.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
