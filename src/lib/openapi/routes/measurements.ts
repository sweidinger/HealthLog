/**
 * OpenAPI route table — measurements, batch ingest, bulk delete, sleep night.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  createMeasurementSchema,
  listMeasurementsSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { seriesBatchQuerySchema } from "@/lib/validations/series-batch";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { dataEnvelope, moduleDisabledResponse, stdResponses } from "./shared";

const batchEntrySchema = z
  .object({
    hkIdentifier: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`).",
      ),
    value: z.number().finite(),
    unit: z.string().min(1).max(60),
    startDate: z.iso.datetime({ offset: true }),
    endDate: z.iso.datetime({ offset: true }),
    sleepStage: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "HKCategoryValueSleepAnalysis codepoint; only for sleep samples.",
      ),
    categoryValue: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        "v1.10.0 — `HKCategoryValue` codepoint for an EVENT-class category sample (irregular-rhythm, high/low-HR, walking-steadiness, breathing-disturbance). Carries the device's own classification verdict / severity, which the server resolves to a stored `rhythmClassification`. HealthLog stores ONLY the device's result — it never re-classifies. Ignored for non-event identifiers.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .describe("HKSample.uuid string — the dedup key."),
    externalSourceVersion: z.string().min(1).max(120).optional(),
    // v1.8.6 W6 — optional per-entry source tag. Defaults to
    // `APPLE_HEALTH` server-side when omitted, so legacy clients are
    // unchanged. Restricted to the `{APPLE_HEALTH, MANUAL}` subset of
    // `MeasurementSource`: `WITHINGS` / `IMPORT` are server-owned and
    // rejected on this client-facing route.
    source: z
      .enum(["APPLE_HEALTH", "MANUAL"])
      .optional()
      .describe(
        "Source attribution for the row. Defaults to `APPLE_HEALTH` when omitted. Send `MANUAL` to tag rows the user entered by hand on-device (e.g. the standalone adopt-on-pair backfill). Part of the `(userId, type, source, externalId)` dedup key, so the same externalId under a different source is a distinct row. `WITHINGS` / `IMPORT` are not accepted here.",
      ),
    // v1.4.25 W8c — optional device-type tag fed into the canonical
    // source picker's second axis. NULL is treated as `unknown`;
    // legacy iOS builds that don't ship the field continue to work.
    deviceType: deviceTypeEnum
      .nullable()
      .optional()
      .describe(
        "Device class mapped from `HKDevice.model`. Used by the analytics aggregator to break ties when the same source contributed multiple devices for the same day. Omit (or send null) on legacy clients — the server treats it as `unknown` and the picker falls through.",
      ),
  })
  .meta({ id: "AppleHealthBatchEntry" });

const batchPayloadSchema = z
  .object({
    entries: z.array(batchEntrySchema).min(1).max(500),
  })
  .meta({
    id: "AppleHealthBatchRequest",
    description:
      "Apple Health batch ingest. ≤500 entries per call; idempotent via `Idempotency-Key`.",
  });

const batchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(["inserted", "duplicate", "skipped"]),
    reason: z.string().optional(),
  })
  .meta({ id: "AppleHealthBatchEntryResult" });

const batchResponse = z
  .object({
    inserted: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    entries: z.array(batchEntryResult),
  })
  .meta({ id: "AppleHealthBatchResponse" });

const deleteByExternalIdsRequest = z
  .object({
    externalIds: z.array(z.string().min(1).max(120)).min(0).max(500),
  })
  .meta({
    id: "MeasurementsDeleteByExternalIdsRequest",
    description:
      "iOS deletion-sync. Up to 500 externalIds per call; matching rows owned by other users are silently skipped (cross-user 404 guard).",
  });

const deleteByExternalIdsResponse = z
  .object({
    deletedCount: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsDeleteByExternalIdsResult" });

// v1.15.13 — multi-select bulk soft-delete for the measurements
// management list. Ids are scoped to the caller; forged / foreign ids
// are silent no-ops (no existence leak). Soft-delete (tombstone), so the
// rows surface in the `/api/sync/changes` delta feed.
const bulkDeleteMeasurementsRequest = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  })
  .meta({
    id: "MeasurementsBulkDeleteRequest",
    description:
      "1..200 measurement ids, scoped to the caller. Forged / foreign ids are silently skipped (no existence leak).",
  });

const bulkDeleteMeasurementsResponse = z
  .object({
    deleted: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsBulkDeleteResult" });

// v1.16.4 — un-tombstone for the management list's delete-Undo
// affordance. Same id-scoping rules as the bulk delete: forged /
// foreign / not-deleted ids are silent no-ops.
const restoreMeasurementsRequest = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  })
  .meta({
    id: "MeasurementsRestoreRequest",
    description:
      "1..200 measurement ids, scoped to the caller. Forged / foreign / not-deleted ids are silently skipped (no existence leak).",
  });

const restoreMeasurementsResponse = z
  .object({
    restored: z.number().int().nonnegative(),
  })
  .meta({ id: "MeasurementsRestoreResult" });

export const measurementResource = z
  .object({
    id: z.string(),
    type: measurementTypeEnum,
    value: z.number(),
    unit: z.string(),
    measuredAt: z.iso.datetime({ offset: true }),
    source: measurementSourceEnum,
    notes: z.string().nullable().optional(),
  })
  .meta({
    id: "MeasurementResource",
    description: "Server-shaped measurement row returned by GET endpoints.",
  });

// ── Sleep night (v1.11.5 hypnogram source) ──────────────────────────

const sleepStageEnum = z.enum([
  "IN_BED",
  "AWAKE",
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
]);

const sleepSegmentResource = z.object({
  stage: sleepStageEnum.nullable(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  minutes: z.number().int().nonnegative(),
});

const sleepSessionResource = z.object({
  night: z.string().describe("Wake-day key (YYYY-MM-DD)."),
  source: measurementSourceEnum.nullable(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  asleepMinutes: z.number().int().nonnegative(),
  inBedMinutes: z.number().int().nonnegative().nullable(),
  awakeMinutes: z.number().int().nonnegative().nullable(),
  awakenings: z.number().int().nonnegative(),
  reconstructed: z
    .boolean()
    .describe(
      "True when the source has no per-stage onset timestamps and the server synthesised a contiguous timeline in a fixed physiological order (WHOOP). The client renders the hypnogram but labels it an approximate layout and never recomputes. False for real-series sources (Apple Health / Withings / Fitbit).",
    ),
  stages: z.record(sleepStageEnum, z.number().int().nonnegative()),
  segments: z.array(sleepSegmentResource),
});

const sleepNightResponse = z
  .object({
    night: z.string().nullable(),
    main: sleepSessionResource.nullable(),
    naps: z.array(sleepSessionResource),
  })
  .meta({
    id: "SleepNightResource",
    description:
      "One reconstructed sleep night: the main session's hypnogram segments + breakdown, plus same-wake-day naps surfaced separately.",
  });

// ── Sleep rhythm (sleep-debt + chronotype, v1.17.0) ──────────────────
//
// Server-authoritative timing signals computed off the SAME canonical night
// reconstruction the Sleep Score reads. Both carry a calm not-yet-ready state
// (`partial` / `learning`) below their night thresholds — they never assert a
// total / band off thin data.
const sleepDebtResource = z.object({
  state: z
    .enum(["partial", "ready"])
    .describe(
      "`partial` until enough tracked nights exist (calm 'still learning'); `ready` once the rolling window can assert a cumulative debt.",
    ),
  debtMinutes: z
    .number()
    .int()
    .nonnegative()
    .describe("Cumulative sleep debt over the window, in minutes, after caps."),
  needMinutes: z
    .number()
    .int()
    .nonnegative()
    .describe("Age-based sleep need (minutes) used for the per-night deficit."),
  nightsCounted: z.number().int().nonnegative(),
  windowNights: z
    .number()
    .int()
    .positive()
    .describe("Rolling window length in nights."),
  nightsUntilReady: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Nights still needed before the debt is asserted (0 when ready).",
    ),
});

const chronotypeBandEnum = z.enum([
  "extreme_early",
  "early",
  "intermediate",
  "late",
  "extreme_late",
]);

const chronotypeResource = z.object({
  state: z
    .enum(["learning", "ready"])
    .describe(
      "`learning` until enough free-day nights exist (no band asserted); `ready` once the free-day sample is large enough.",
    ),
  msfMinutes: z
    .number()
    .nullable()
    .describe("Mid-sleep on free days (minutes-of-day), null while learning."),
  msfScMinutes: z
    .number()
    .nullable()
    .describe(
      "Sleep-debt-corrected mid-sleep on free days (MSFsc, minutes-of-day), null while learning.",
    ),
  band: chronotypeBandEnum
    .nullable()
    .describe("MCTQ chronotype band off MSFsc, null while learning."),
  socialJetlagMinutes: z
    .number()
    .nullable()
    .describe(
      "Social jetlag = circular |MSF_work − MSF_free| in minutes, null when one side is missing.",
    ),
  freeNightsCounted: z.number().int().nonnegative(),
  workNightsCounted: z.number().int().nonnegative(),
  freeNightsUntilReady: z
    .number()
    .int()
    .nonnegative()
    .describe("Free-day nights still needed before a band is asserted."),
});

const sleepRhythmResponse = z
  .object({
    sleepDebt: sleepDebtResource,
    chronotype: chronotypeResource,
  })
  .meta({
    id: "SleepRhythmResource",
    description:
      "Server-authoritative sleep-rhythm read: cumulative sleep debt over the rolling window + MCTQ chronotype (MSF/MSFsc band, social jetlag). Free vs work nights default to weekend = free in the user's timezone (no work calendar). A view over existing per-stage SLEEP_DURATION rows — no schema, no new type.",
  });

// ── Time-series adapter (iOS chart source) ───────────────────────────
//
// v1.16.16 — documents the long-shipped `GET /api/measurements/series`
// the iOS charts read off. The response is described AS-IS: `points`
// carry `id`/`at`/`value`/`secondary` (the route's wire field names),
// not the canonical `measuredAt`. `secondary` pairs the diastolic value
// for `bloodPressure`; `sleepStages` is per-night stage hours for `sleep`
// and null otherwise. `unit` is the resolved per-kind token (glucose +
// sleep resolve at request time to the user's display unit / hours).
const seriesKindEnum = z.enum([
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
  "restingHeartRate",
  "heartRateVariability",
  "vo2Max",
]);

const seriesQuerySchema = z.object({
  kind: seriesKindEnum,
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .default(30)
    .describe(
      "Look-back window in days (1..3650, default 30). `sleep` is internally capped to 365 regardless of the requested range.",
    ),
});

const seriesPointSchema = z.object({
  id: z
    .string()
    .describe("Measurement row id, or `sleep:<wake-day>` for a sleep night."),
  at: z.iso.datetime({ offset: true }).describe("Point timestamp (ISO-8601)."),
  value: z.number().describe("Primary value in the top-level `unit`."),
  secondary: z
    .number()
    .nullable()
    .describe(
      "Diastolic value for `kind=bloodPressure` (paired within ±5 min); null for every other kind.",
    ),
  sleepStages: z
    .record(z.string(), z.number())
    .nullable()
    .optional()
    .describe(
      "Per-stage hours for a `kind=sleep` night (CORE/DEEP/REM/…); null/absent for non-sleep kinds.",
    ),
});

const seriesResponse = z
  .object({
    kind: seriesKindEnum,
    unit: z
      .string()
      .describe(
        "Resolved unit token for `value`. `glucose` follows the user's mg/dL|mmol/L preference; `sleep` is `h` (per-night time-asleep in hours).",
      ),
    points: z.array(seriesPointSchema),
    stats: z
      .object({
        mean: z.number(),
        min: z.number(),
        max: z.number(),
        stdDev: z.number(),
        count: z.number().int().nonnegative(),
      })
      .describe("Summary over the returned points; all-zero when empty."),
  })
  .meta({
    id: "MeasurementsSeriesResponse",
    description:
      "iOS-friendly per-kind time series: one point per reading (or per reconstructed night for `sleep`), an explicit `unit` token, and a summary `stats` block.",
  });

// ── Batched daily series (v1.18.6 dashboard fetch coalescing) ────────
//
// Returns every requested MeasurementType's rollup-backed daily series
// in one response so the dashboard chart row does a single round-trip
// instead of one per chart. Each row mirrors the daily-aggregate shape
// `GET /api/measurements?aggregate=daily&source=rollup` emits.
const seriesBatchRowSchema = z.object({
  type: measurementTypeEnum,
  value: z.number().describe("Daily mean (spot metrics) or SUM (cumulative)."),
  measuredAt: z.iso
    .datetime({ offset: true })
    .describe("Day-bucket start (ISO-8601)."),
  count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Underlying raw-row count for the bucket."),
  minValue: z
    .number()
    .nullable()
    .optional()
    .describe("Per-day minimum (spot metrics only; absent for cumulative)."),
  maxValue: z
    .number()
    .nullable()
    .optional()
    .describe("Per-day maximum (spot metrics only; absent for cumulative)."),
});

const seriesBatchResponse = z
  .object({
    series: z
      .record(measurementTypeEnum, z.array(seriesBatchRowSchema))
      .describe("Per-type daily series, keyed by MeasurementType."),
  })
  .meta({
    id: "MeasurementsSeriesBatchResponse",
    description:
      "Batched daily series — one rollup-backed series per requested type.",
  });

export const measurementPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/measurements/series-batch": {
    get: {
      tags: ["Measurements"],
      summary: "Batched daily series (dashboard fetch coalescing)",
      description:
        "Returns the rollup-backed daily series for every requested MeasurementType in ONE response, so the dashboard chart row does a single round-trip instead of one self-fetch per chart. Each per-type series is byte-identical with `GET /api/measurements?aggregate=daily&source=rollup` for the same window. SLEEP_DURATION is not served here (it rides the per-night reconstruction at `/api/measurements/series?kind=sleep`). Auth via cookie or Bearer.",
      requestParams: {
        query: seriesBatchQuerySchema,
      },
      responses: {
        "200": {
          description: "Per-type daily series.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                seriesBatchResponse,
                "GetMeasurementsSeriesBatchResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/series": {
    get: {
      tags: ["Measurements"],
      summary: "Per-kind time series (iOS chart source)",
      description:
        "Maps a camelCase `kind` to the canonical MeasurementType(s) and returns an ordered point series with an explicit `unit` token and a summary `stats` block. `bloodPressure` pairs systolic + diastolic (`secondary`) within ±5 min so one fetch renders the dual-line chart; `sleep` collapses per-stage rows into one per-night point carrying time-asleep in hours (`sleepStages` holds the per-stage breakdown) and is internally capped to 365 days. `glucose` values + `unit` resolve to the user's mg/dL|mmol/L preference. Auth via cookie or Bearer.",
      requestParams: {
        query: seriesQuerySchema,
      },
      responses: {
        "200": {
          description: "Resolved series.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                seriesResponse,
                "GetMeasurementsSeriesResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements": {
    get: {
      tags: ["Measurements"],
      summary: "List measurements",
      description:
        "Filter by type + date range. Response is paged via offset/limit; default limit 100, hard cap 500.",
      requestParams: {
        query: listMeasurementsSchema,
      },
      responses: {
        "200": {
          description: "Measurement page.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  measurements: z.array(measurementResource),
                  total: z.number().int().nonnegative(),
                }),
                "ListMeasurementsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Measurements"],
      summary: "Create one measurement",
      description:
        "Single ingest. Use `/api/measurements/batch` for Apple Health upload streams.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMeasurementSchema } },
      },
      responses: {
        "201": {
          description: "Created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementResource,
                "CreateMeasurementResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/batch": {
    post: {
      tags: ["Measurements"],
      summary: "Apple Health batch ingest",
      description:
        "Up to 500 HealthKit entries per call. Idempotent via the `Idempotency-Key` header (replay window 24h). Per-entry status lets the iOS client advance its sync cursor accurately. v1.4.25 W8c adds an optional `deviceType` per entry — feed it from `HKDevice.model` so the cross-source canonical picker can break Apple-Watch-vs-iPhone ties; null/absent stays backward-compatible with v1.4.23 clients.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: batchPayloadSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(batchResponse, "BatchMeasurementsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/by-external-ids": {
    delete: {
      tags: ["Measurements"],
      summary: "Delete measurements by external ID (iOS deletion-sync)",
      description:
        "Removes the user's measurement rows whose externalId is in the request list. Rows owned by another user are silently skipped (cross-user 404 guard). Up to 500 externalIds per call.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: deleteByExternalIdsRequest },
        },
      },
      responses: {
        "200": {
          description: "Delete batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deleteByExternalIdsResponse,
                "MeasurementsDeleteByExternalIdsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/bulk-delete": {
    post: {
      tags: ["Measurements"],
      summary: "Bulk soft-delete measurements",
      description:
        "Soft-deletes (tombstones) up to 200 of the caller's measurement rows in one call, mirroring the single-DELETE contract. Idempotent via the `Idempotency-Key` header; rate-limited `measurements:bulk-delete:<userId>`. Forged / foreign / already-deleted ids are silently skipped — `deleted` is the count of rows actually tombstoned. The deletions surface in `/api/sync/changes` as tombstones.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: bulkDeleteMeasurementsRequest },
        },
      },
      responses: {
        "200": {
          description: "Bulk delete processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                bulkDeleteMeasurementsResponse,
                "MeasurementsBulkDeleteResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/measurements/restore": {
    post: {
      tags: ["Measurements"],
      summary: "Restore soft-deleted measurements",
      description:
        "Un-tombstones up to 200 of the caller's soft-deleted measurement rows in one call — the delete-Undo counterpart to `/api/measurements/bulk-delete`. Idempotent via the `Idempotency-Key` header; rate-limited `measurements:restore:<userId>`. Forged / foreign / not-deleted ids are silently skipped — `restored` is the count of rows actually un-tombstoned. The restored rows re-surface in `/api/sync/changes` as upserts.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: restoreMeasurementsRequest },
        },
      },
      responses: {
        "200": {
          description: "Restore processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                restoreMeasurementsResponse,
                "MeasurementsRestoreResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sleep/night": {
    get: {
      tags: ["Measurements"],
      summary: "Reconstructed sleep night (hypnogram source, v1.11.5)",
      description:
        "Returns one night's reconstructed sleep session for the phase-progression (hypnogram) view: the canonical source's stage segments (each with an absolute start/end), the per-stage breakdown, asleep/in-bed/awake totals, the mid-sleep awakenings count, and same-wake-day naps surfaced separately. Session-clustered, keyed by the local wake day, collapsed to one source via the sleep priority ladder so two sources never overlay. `date` omitted returns the most recent night. A read-only view over existing per-stage SLEEP_DURATION rows — no schema, no new measurement type.",
      requestParams: {
        query: z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "Wake-day key (YYYY-MM-DD). Omit for the most recent night.",
            ),
        }),
      },
      responses: {
        "200": {
          description: "Reconstructed night.",
          content: {
            "application/json": {
              schema: dataEnvelope(sleepNightResponse, "SleepNightResponse"),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/sleep/rhythm": {
    get: {
      tags: ["Measurements"],
      summary: "Sleep rhythm — sleep-debt + chronotype (v1.17.0)",
      description:
        "Returns the two server-authoritative sleep-timing signals the Sleep page + iOS render off the same canonical night reconstruction the Sleep Score uses: cumulative `sleepDebt` over the rolling window (calm `partial` state under the night threshold) and MCTQ `chronotype` (MSF/MSFsc band + social jetlag, `learning` state until enough free-day nights exist). Free vs work nights default to weekend = free in the user's timezone (no work calendar). A read-only view over existing per-stage SLEEP_DURATION rows — no schema, no new measurement type.",
      responses: {
        "200": {
          description: "Sleep-debt + chronotype DTO.",
          content: {
            "application/json": {
              schema: dataEnvelope(sleepRhythmResponse, "SleepRhythmResponse"),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
};
