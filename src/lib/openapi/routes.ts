/**
 * OpenAPI route table — populated incrementally.
 *
 * v1.4.23 baseline covers the routes the v1.5 iOS app touches end-to-end:
 *   - POST /api/auth/login
 *   - POST /api/auth/passkey/login-verify
 *   - POST /api/auth/refresh
 *   - GET  /api/measurements
 *   - POST /api/measurements
 *   - POST /api/measurements/batch    (W2 — Apple Health ingest)
 *   - POST /api/devices               (W3 — APNs registration)
 *   - GET  /api/insights/comprehensive
 *
 * Schemas come from `src/lib/validations/*` so the wire contract stays
 * single-source-of-truth. The `.meta()` annotations on each schema land
 * the title + description in `components.schemas.*` automatically.
 *
 * Routes are intentionally registered as inline operation objects
 * rather than via a wrapping helper — `zod-openapi`'s `createDocument`
 * type-checks the route table directly, which catches schema-shape
 * regressions at typecheck time.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createMeasurementSchema,
  listMeasurementsSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import {
  deviceTypeEnum,
  sourcePrioritySchema,
} from "@/lib/validations/source-priority";
import { createBatchWorkoutSchema } from "@/lib/validations/workout";
import {
  createMedicationSchema,
  updateMedicationSchema,
  intakeSchema,
  MEDICATION_CATEGORY_VALUES,
  MEDICATION_TREATMENT_CLASS_VALUES,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import { ACCEPTED_INSIGHTS_TILE_IDS } from "@/lib/insights-layout";
import { COACH_FACT_CATEGORIES } from "@/lib/ai/coach/facts";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import { createShareLinkSchema } from "@/lib/validations/clinician-share-link";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";
import {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
} from "@/lib/insights/derived/registry";
import { ANALYTICS_RANGES } from "@/lib/analytics/range-delta";
import {
  flowLevelEnum,
  ovulationTestEnum,
  cervicalMucusEnum,
  homeTestResultEnum,
  cycleTrackingGoalEnum,
  cycleDayLogInputSchema,
  cycleDayLogPatchSchema,
  cycleDayLogQuerySchema,
  cycleBulkSchema,
  cyclePeriodSchema,
  cyclePrefsSchema,
} from "@/lib/validations/cycle";

/**
 * Common envelopes — every HealthLog API response wraps payload in
 * `{ data, error, meta? }`. The OpenAPI surface mirrors that contract
 * so iOS / external-ingest clients can decode uniformly.
 */
const errorEnvelope = z
  .object({
    data: z.null(),
    error: z.string(),
    meta: z
      .object({
        requestId: z.string().optional(),
        errorCode: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    id: "ErrorEnvelope",
    description: "Standard error response: data is null, error is human prose.",
  });

function dataEnvelope<T extends z.ZodType>(payload: T, id: string) {
  return z
    .object({
      data: payload,
      error: z.null(),
      meta: z.object({ requestId: z.string().optional() }).optional(),
    })
    .meta({ id });
}

// ── Schemas — annotated for spec emission ────────────────────────────

measurementTypeEnum.meta({
  id: "MeasurementType",
  description:
    "DB-stored measurement category. v1.4.23 added 7 Apple Health values (HRV, resting HR, active energy, flights, walking/running distance, VO2 max, body temperature).",
});

measurementSourceEnum.meta({
  id: "MeasurementSource",
  description:
    "Origin of the measurement. v1.4.23 added APPLE_HEALTH for the iOS HealthKit batch ingest path.",
});

loginPasswordSchema.meta({
  id: "LoginPasswordRequest",
  description:
    "Email-or-username login. The native-client flow returns a paired access + refresh token when X-Client-Type: native or the iOS UA prefix is present.",
});

createMeasurementSchema.meta({
  id: "CreateMeasurementRequest",
  description:
    "Single-measurement ingest body. Plausibility-range guard runs server-side; out-of-range values fail 422.",
});

listMeasurementsSchema.meta({
  id: "ListMeasurementsQuery",
  description:
    "Query params for the measurements list endpoint. `limit` capped at 500.",
});

coachPrefsSchema.meta({
  id: "CoachPrefs",
  description:
    "Per-user Coach prompt-tuning preferences (v1.4.23 H4). All fields default to the legacy v1.4.22 behaviour when omitted.",
});

createBatchWorkoutSchema.meta({
  id: "CreateBatchWorkoutRequest",
  description:
    "Typed workout batch ingest. Each entry is an HKWorkout-aligned record with an optional nested GeoJSON LineString route AND an optional route-independent per-workout heart-rate series (`samples`: `[{ t, hr?, speedMs?, power?, cadence? }]`, up to 30 000 points). The `samples` series is the strain-engine input for indoor workouts that have no GPS route. Up to 100 workouts per call; nested route geometry capped at 20 000 points. Withings server-to-server callers pass source: WITHINGS and ship no route (Withings reports aggregates only).",
});

const coachMessageFeedbackBody = z
  .object({
    rating: z.enum(["helpful", "unhelpful"]),
    reason: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "CoachMessageFeedbackRequest",
    description:
      "Per-message helpful/unhelpful feedback (v1.4.23 H7). Optional `reason` is free-form prose, capped at 200 chars.",
  });

// v1.4.49 — single schema for the per-user Coach opt-out flag. Previously
// split into `disableCoachBody` (PATCH request) and `disableCoachData`
// (response payload), both `z.object({ disableCoach: z.boolean() })`. The
// payload was passed through `dataEnvelope(..., "GetDisableCoachResponse")`
// / `dataEnvelope(..., "PatchDisableCoachResponse")` which IDs the
// envelope wrapper — the inner flag carries its own `.meta()` and now
// renders as a single `$ref: "#/components/schemas/DisableCoachFlag"` in
// both the request body and both response envelopes.
const disableCoachFlag = z
  .object({
    disableCoach: z.boolean(),
  })
  .meta({
    id: "DisableCoachFlag",
    description:
      "Per-account Coach opt-out toggle (v1.4.47 W3). `true` hides the Coach FAB and short-circuits its API gates.",
  });

// v1.8.6 — profile read/write surface for the native client. The
// runtime validation lives in `src/lib/validations/auth.ts`
// (`profileSchema`, whose transforms normalise empty → null and run the
// KVNR/IKNR refines); the OpenAPI shapes below mirror the wire contract
// without those transforms so the spec stays a clean nullable-field
// document. `insurerIkNumber` is the new v1.8.6 field: optional, 9-digit
// German IKNR, surfaced on the FHIR `Coverage` payor.
const profileUpdateRequest = z
  .object({
    email: z.email().nullable().optional(),
    heightCm: z.number().min(50).max(300).nullable().optional(),
    dateOfBirth: z.string().nullable().optional(),
    gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
    displayName: z.string().min(1).max(80).nullable().optional(),
    locale: z.enum(["de", "en"]).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    moodReminderEnabled: z.boolean().optional(),
    fullName: z.string().max(120).nullable().optional(),
    insurerName: z.string().max(120).nullable().optional(),
    insuranceNumber: z
      .string()
      .nullable()
      .optional()
      .describe("German KVNR. Empty/null clears it; mod-10 check enforced."),
    insurerIkNumber: z
      .string()
      .nullable()
      .optional()
      .describe(
        "German insurer institution number (IKNR). Optional; empty/null clears it. A non-empty value must be exactly 9 digits (no checksum enforced).",
      ),
  })
  .meta({
    id: "ProfileUpdateRequest",
    description:
      "Partial profile update. Every field is optional; an omitted field is left untouched, an explicit null (or empty string) clears it. `userId` is never accepted — it is narrowed from the session/token.",
  });

const profileResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    insuranceNumber: z
      .string()
      .nullable()
      .describe("German KVNR, decrypted for the form prefill."),
  })
  .meta({
    id: "ProfileResponse",
    description:
      "Flattened profile fields for the native client (GET). The KVNR is decrypted server-side; the IKNR (v1.8.6) is plaintext at rest.",
  });

// The PATCH echo mirrors GET but reports KVNR presence as a boolean
// (`hasInsuranceNumber`) rather than re-emitting the decrypted value.
const profileUpdateResponse = z
  .object({
    username: z.string(),
    displayName: z.string().nullable().optional(),
    email: z.string().nullable(),
    dateOfBirth: z.iso.datetime({ offset: true }).nullable(),
    gender: z.enum(["MALE", "FEMALE"]).nullable(),
    heightCm: z.number().nullable(),
    locale: z.string().nullable(),
    timezone: z.string(),
    moodReminderEnabled: z.boolean(),
    fullName: z.string().nullable(),
    insurerName: z.string().nullable(),
    insurerIkNumber: z
      .string()
      .nullable()
      .describe("German insurer institution number (IKNR), 9 digits."),
    hasInsuranceNumber: z
      .boolean()
      .describe("Whether a KVNR is on file (the value itself is not echoed)."),
  })
  .meta({
    id: "ProfileUpdateResponse",
    description:
      "Profile echo returned by the PATCH/PUT update path. Reports KVNR presence as a boolean rather than re-emitting the decrypted value.",
  });

// ── Sub-schemas owned here (route-specific shapes) ───────────────────

const passkeyLoginVerifyRequest = z
  .object({
    challengeId: z
      .string()
      .min(1)
      .describe("Server-issued WebAuthn challenge id."),
    credential: z
      .object({
        id: z.string(),
        rawId: z.string(),
        type: z.literal("public-key"),
        response: z.record(z.string(), z.unknown()),
        authenticatorAttachment: z
          .enum(["platform", "cross-platform"])
          .optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      })
      .describe("SimpleWebAuthn-style assertion response payload."),
  })
  .meta({
    id: "PasskeyLoginVerifyRequest",
    description:
      "Passkey assertion verification. Same native-client token issuance as the password path.",
  });

const refreshRequest = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .describe("Caller-presented refresh token (`hlr_<64hex>`)."),
    revoke: z
      .boolean()
      .optional()
      .describe("When true, revoke the supplied token instead of rotating."),
  })
  .meta({
    id: "RefreshTokenRequest",
    description:
      "Exchange a one-time-use refresh token for a fresh access + refresh pair.",
  });

const accessRefreshBundle = z
  .object({
    user: z.object({ id: z.string(), username: z.string() }).optional(),
    token: z.string().describe("Access token (`hlk_<64hex>`)."),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z
      .string()
      .optional()
      .describe(
        "Refresh token (`hlr_<64hex>`); only present for native-policy callers.",
      ),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "AccessRefreshBundle",
    description:
      "Native-client token bundle returned by login + refresh. Web cookie-only callers see only `user`.",
  });

const deviceRegisterRequest = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/)
      .describe("Generic device identifier (legacy; APNs token below)."),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/)
      .optional()
      .describe(
        "Hex-encoded APNs device token. Must be paired with `apnsEnvironment`.",
      ),
    apnsEnvironment: z
      .enum(["sandbox", "production"])
      .optional()
      .describe(
        "Gateway the iOS client received `apnsToken` from. Server never auto-detects.",
      ),
    medicationDelivery: z
      .enum(["server", "client"])
      .nullable()
      .optional()
      .describe(
        "v1.7.0 per-device medication-delivery override. NULL / omitted = inherit the user-level roaming default. \"server\" forces server APNs for this device; \"client\" forces local. Stored + echoed; cron suppression stays user-level.",
      ),
  })
  .meta({
    id: "DeviceRegisterRequest",
    description:
      "Native device registration. Re-registering an APNs token belonging to another user returns 409 (cross-user-hijack guard).",
  });

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

const measurementResource = z
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
  stages: z.record(sleepStageEnum, z.number()),
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

// ── Sync (v1.7.0 offline / server-optional) ─────────────────────────

const syncStateResponse = z
  .object({
    userId: z.string(),
    timezone: z.string(),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
    serverNow: z.iso.datetime({ offset: true }),
    measurements: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    mood: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    intakes: z.object({
      lastUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
      liveCount: z.number().int().nonnegative(),
      tombstonedCount: z.number().int().nonnegative(),
    }),
    sync: z
      .object({
        incrementalWindowDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Days an incremental delta stays valid; tracks the native refresh-token lifetime. Beyond it a device re-pairs with a full backfill. iOS derives its window from this rather than hardcoding 60.",
          ),
        tombstoneRetentionDays: z
          .number()
          .int()
          .positive()
          .describe(
            "Horizon past which tombstones may be pruned. A cursor older than this gets `cursorExpired` on `/api/sync/changes`.",
          ),
      })
      .describe("Sync-window metadata the client reads instead of hardcoding."),
  })
  .meta({
    id: "SyncStateResponse",
    description:
      "iOS SyncMode handshake. Each GET also advances the server-side `lastSyncedAt` checkpoint and returns the previous value. The cheap 'should I sync?' summary; the durable delta cursor lives on `/api/sync/changes`.",
  });

const syncMeasurementUpsert = measurementResource
  .extend({
    externalId: z
      .string()
      .nullable()
      .describe("Cross-device dedup key (UUID string or `stats:<id>:<date>`)."),
    syncVersion: z
      .number()
      .int()
      .positive()
      .describe("LWW reconciliation counter; echo to keep the mirror monotonic."),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMeasurementUpsert" });

const syncMeasurementTombstone = z
  .object({
    id: z.string(),
    externalId: z
      .string()
      .nullable()
      .describe("The identity key the client dedups on for measurements."),
    syncVersion: z.number().int().positive(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMeasurementTombstone",
    description:
      "A soft-deleted measurement. Apply tombstones BEFORE upserts within a page to avoid resurrecting a row.",
  });

const syncMoodUpsert = z
  .object({
    id: z.string(),
    date: z.string().describe("YYYY-MM-DD anchored to the row's `tz`."),
    mood: z.string(),
    score: z.number().int(),
    tags: z.string().nullable().describe("JSON array of tag keys, or null."),
    note: z.string().nullable(),
    moodLoggedAt: z.iso.datetime({ offset: true }),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe("LWW reconciliation counter; mood is last-writer-wins by it."),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncMoodUpsert" });

const syncMoodTombstone = z
  .object({
    id: z.string().describe("Server id — the identity key the client dedups on for mood."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncMoodTombstone",
    description:
      "A soft-deleted mood entry, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncIntakeUpsert = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.string(),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Reconciliation counter. An intake is immutable; a correction is a tombstone + re-insert.",
      ),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "SyncIntakeUpsert" });

const syncIntakeTombstone = z
  .object({
    id: z.string().describe("Server id — the identity key the client dedups on for intakes."),
    syncVersion: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "SyncIntakeTombstone",
    description:
      "A soft-deleted medication intake, keyed on server `id`. Apply before upserts within the domain page.",
  });

const syncChangesQuery = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "Opaque multi-domain keyset cursor from the previous page. Treat as fully opaque — echo, never parse. Omit for the initial sync.",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Page size, default 200, hard cap 500."),
  })
  .meta({ id: "SyncChangesQuery" });

const syncChangesResponse = z
  .object({
    serverNow: z.iso.datetime({ offset: true }),
    cursor: z
      .string()
      .nullable()
      .describe("Opaque cursor to echo into the next request."),
    hasMore: z
      .boolean()
      .describe("False once the client is caught up as of `serverNow`."),
    cursorExpired: z
      .boolean()
      .describe(
        "True when the supplied cursor predates tombstone retention — drop the cursor and do a clean initial sync.",
      ),
    changes: z.object({
      measurements: z.object({
        upserts: z.array(syncMeasurementUpsert),
        tombstones: z.array(syncMeasurementTombstone),
      }),
      mood: z.object({
        upserts: z.array(syncMoodUpsert),
        tombstones: z.array(syncMoodTombstone),
      }),
      intakes: z.object({
        upserts: z.array(syncIntakeUpsert),
        tombstones: z.array(syncIntakeTombstone),
      }),
    }),
  })
  .meta({
    id: "SyncChangesResponse",
    description:
      "Multi-domain delta page (v1.7.0): measurements + mood + intakes. One opaque multi-domain keyset cursor; tombstones apply before upserts within each domain. Tombstone identity: measurements key on externalId, mood + intakes on server id. The iOS consumer is measurements-only this cycle; mood + intakes are forward-prep.",
  });

// v1.4.48 H-APNs-1 — admin diagnostic endpoint for the notification
// subsystem. Mirrors the runtime types in
// `src/app/api/admin/notifications/diagnostic/route.ts`: APNs tokens
// are surfaced only as 8-char hex prefix + suffix (never the full
// token), per-channel `enabled` + `configPresent` booleans, and a
// `recentPushAttempts` array reserved for the v1.4.48+ follow-up that
// adds the dedicated PushAttempt table (currently always `[]` so the
// shape stays stable for iOS consumers).
const adminDiagnosticDevice = z
  .object({
    id: z.string(),
    platform: z.string(),
    hasApnsToken: z.boolean(),
    apnsTokenPrefix: z.string().nullable(),
    apnsTokenSuffix: z.string().nullable(),
    apnsEnvironment: z.string().nullable(),
    lastSeenAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticDevice",
    description:
      "Per-device APNs registration snapshot. The APNs token is masked to its 8-char hex prefix + 8-char suffix so an operator can correlate with iOS-side logs without disclosing the delivery target.",
  });

const adminDiagnosticChannel = z
  .object({
    type: z.string(),
    enabled: z.boolean(),
    configPresent: z.boolean(),
  })
  .meta({
    id: "AdminDiagnosticChannel",
    description:
      "Per-channel state. `configPresent` is true when the channel's encrypted-JSON config blob carries the field the corresponding sender will read (chatId+botToken for TELEGRAM, topic for NTFY); WEB_PUSH/APNS rely on sibling tables so the row's existence is the signal.",
  });

const adminDiagnosticPushAttempt = z
  .object({
    eventType: z.string(),
    channel: z.string(),
    result: z.string(),
    reason: z.string().nullable(),
    at: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticPushAttempt",
    description:
      "Single push delivery attempt. Reserved for the v1.4.48+ follow-up that adds the dedicated PushAttempt table — currently always returned as an empty array so the response shape stays stable for iOS consumers.",
  });

const adminDiagnosticData = z
  .object({
    devices: z.array(adminDiagnosticDevice),
    notificationChannels: z.array(adminDiagnosticChannel),
    recentPushAttempts: z.array(adminDiagnosticPushAttempt),
  })
  .meta({
    id: "AdminDiagnosticData",
    description:
      "Admin notification diagnostic snapshot for the calling user — what the dispatcher would see when targeting this account. Surfaces device tokens (masked), channel state, and recent push attempts so an operator can debug an iOS / Web Push / Telegram / ntfy issue without DB shell access.",
  });

// ── Medications (v1.5 scheduling) ────────────────────────────────────
//
// The Medication + MedicationSchedule resource shapes documented below
// follow the wire envelope the seven routes registered at the bottom of
// this file emit. `windowStart` / `windowEnd` / `daysOfWeek` /
// `intervalWeeks` are the legacy primitives kept for backwards
// compatibility through the v1.5.x line; `timesOfDay`, `rrule`,
// `rollingIntervalDays`, and `reminderGraceMinutes` are the v1.5
// first-class primitives the wizard + iOS cadence picker write. The
// XOR between `rrule` and `rollingIntervalDays` is documented at the
// schema description AND enforced by the route + a DB CHECK constraint
// so iOS code-gen surfaces the mutual exclusion.

const medicationCategoryEnum = z
  .enum(MEDICATION_CATEGORY_VALUES)
  .meta({
    id: "MedicationCategory",
    description:
      "Clinical taxonomy stored in the `medication_categories` side-table. Orthogonal to `MedicationTreatmentClass`.",
  });

const medicationTreatmentClassEnum = z
  .enum(MEDICATION_TREATMENT_CLASS_VALUES)
  .meta({
    id: "MedicationTreatmentClass",
    description:
      "Prisma-level treatment-class discriminator. `GLP1` unlocks the GLP-1 specialist surfaces (injection-site rotation, titration history, pen inventory, GLP-1-aware Coach).",
  });

const medicationScheduleResource = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    windowStart: z
      .string()
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). Preserved for backwards compatibility; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z.string().nullable(),
    dose: z
      .string()
      .nullable()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    daysOfWeek: z
      .string()
      .nullable()
      .describe(
        "Legacy persisted recurrence encoding (`null` | `1,3,5` | `i2;1,3,5`). v1.5 readers consult `rrule` first; the field is kept for pre-v1.5 rows. v1.6.0 drops the column.",
      ),
    timesOfDay: z
      .array(z.string())
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Backfilled to `[windowStart]` for every pre-v1.5 row.",
      ),
    reminderGraceMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Reminder grace window in minutes. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    rrule: z
      .string()
      .nullable()
      .describe(
        "RFC 5545 RRULE string (subset). Used for calendar-anchored cadences. **Mutually exclusive with `rollingIntervalDays`** — exactly one of the two is non-null on any v1.5+ schedule (or both are null on legacy rows that haven't been touched since the migration).",
      ),
    rollingIntervalDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt`. **Mutually exclusive with `rrule`.**",
      ),
    scheduleType: z
      .enum(["SCHEDULED", "PRN", "CYCLIC"])
      .describe(
        "v1.7.0 schedule-type discriminator. SCHEDULED = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    cyclicOnWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.7.0 cyclic \"on\" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.",
      ),
    cyclicOffWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.7.0 cyclic \"off\" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.",
      ),
  })
  .meta({
    id: "MedicationSchedule",
    description:
      "Schedule entry attached to a medication. v1.5 promotes `timesOfDay` to first-class and introduces `rrule` (calendar-anchored cadences) and `rollingIntervalDays` (flexible-rolling cadences). The two recurrence primitives are mutually exclusive — enforced by the Zod refine on writes, the route layer, and a DB CHECK constraint (`medication_schedules_rrule_xor_rolling`). v1.7.0 adds `scheduleType` (SCHEDULED / PRN / CYCLIC) and the cyclic on/off-week fields.",
  });

const medicationResource = z
  .object({
    id: z.string(),
    name: z.string(),
    dose: z.string(),
    treatmentClass: medicationTreatmentClassEnum,
    dosesPerUnit: z
      .number()
      .int()
      .nullable()
      .describe(
        "Doses per pen / vial for inventory tracking. NULL = inventory tracking off.",
      ),
    active: z.boolean(),
    notificationsEnabled: z.boolean(),
    liveActivityEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    criticalAlarmEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    atcCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional WHO ATC classification code (active-substance class, e.g. `A10BX10`). User/clinician-asserted; never machine-guessed. Emitted on the FHIR `medicationCodeableConcept` under `http://www.whocc.no/atc`. NULL = no code captured.",
      ),
    rxNormCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional RxNorm RxCUI (numeric, US identifier, e.g. `2601723`). Secondary FHIR coding under `http://www.nlm.nih.gov/research/umls/rxnorm`, alongside any ATC code. NULL = no code captured.",
      ),
    pausedAt: z.iso.datetime({ offset: true }).nullable(),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
    nextDueAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.7.0 server-computed next due instant across all the medication's schedules (earliest `nextOccurrenceAfter`). Read-only — computed, not stored. NULL when no schedule has an upcoming slot (paused, one-shot in the past, `endsOn` crossed, every schedule PRN). The list GET is cached 60 s, so a 60 s staleness is accepted.",
      ),
    startsOn: z
      .iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course start (ISO date). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL means active from creation.",
      ),
    endsOn: z
      .iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course end (ISO date). NULL means chronic. Equals `startsOn` when `oneShot` is true.",
      ),
    oneShot: z
      .boolean()
      .describe(
        "v1.5 single-administration flag. When true the medication has at most one schedule (no `rrule` / `rollingIntervalDays`), and `active` auto-flips to false once the dose is logged.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    schedules: z.array(medicationScheduleResource),
  })
  .meta({
    id: "Medication",
    description:
      "Server-shaped medication row returned by GET / POST / PUT endpoints. Carries the v1.5 course-window fields (`startsOn`, `endsOn`, `oneShot`) at the medication level and the per-schedule cadence fields on the nested `schedules` array.",
  });

const medicationListEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
    lastTakenAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Latest non-skipped `MedicationIntakeEvent.takenAt` for the medication. Drives the rolling-cadence countdown surface.",
      ),
    todayEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of intake events scheduled for today (user-local day window).",
      ),
  })
  .meta({
    id: "MedicationListEntry",
    description:
      "List-row variant of the medication resource enriched with the joined `category`, `lastTakenAt`, and `todayEventCount` fields the dashboard + iOS client consume. The base medication fields (`id`, `name`, `dose`, `treatmentClass`, `dosesPerUnit`, `active`, `notificationsEnabled`, `pausedAt`, `snoozedUntil`, `startsOn`, `endsOn`, `oneShot`, `createdAt`, `updatedAt`, `schedules`) are inlined; see the `Medication` component for their semantics.",
  });

const medicationDetailEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
  })
  .meta({
    id: "MedicationDetail",
    description:
      "Detail variant of the medication resource enriched with the joined `category`. The base medication fields are inlined; see the `Medication` component for their semantics.",
  });

const medicationIntakeEventResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.enum(["WEB", "API", "REMINDER", "IMPORT"]),
    idempotencyKey: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationIntakeEvent",
    description:
      "Single dose log row. `takenAt` is non-null for confirmed intakes; `skipped:true` represents a deliberately-missed dose (no inventory consumption).",
  });

const medicationCadenceTimelinePoint = z
  .object({
    day: z.iso.datetime({ offset: true }),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    scheduleIndex: z.number().int().nonnegative(),
    status: z.string(),
  })
  .meta({
    id: "MedicationCadenceTimelinePoint",
    description:
      "One expected-vs-actual dose slot for the cadence timeline chart. `status` is one of `taken | skipped | missed | pending | future` and drives the chip colour.",
  });

const medicationCadenceChips = z
  .object({
    adherenceRate: z.number(),
    streakDays: z.number().int().nonnegative(),
    expectedSlots: z.number().int().nonnegative(),
    actualDoses: z.number().int().nonnegative(),
  })
  .meta({
    id: "MedicationCadenceChips",
    description:
      "Four compliance summary values for the medication detail page chip row.",
  });

const medicationCadenceResponse = z
  .object({
    windowDays: z.number().int().positive(),
    anchorIso: z.iso.datetime({ offset: true }),
    next: z
      .object({
        windowStart: z.iso.datetime({ offset: true }),
        windowEnd: z.iso.datetime({ offset: true }),
        scheduleIndex: z.number().int().nonnegative(),
      })
      .nullable(),
    chips: medicationCadenceChips,
    timeline: z.array(medicationCadenceTimelinePoint),
  })
  .meta({
    id: "MedicationCadenceResponse",
    description:
      "Cadence + compliance read for a single medication. `next` is the upcoming-dose envelope (null when the course has ended or the rolling clock has no pinning intake yet); `timeline` walks the requested `windowDays` worth of slots in ascending time order.",
  });

const complianceResult = z
  .object({
    totalExpected: z
      .number()
      .int()
      .nonnegative()
      .describe("Full denominator over the window: `taken + skipped + missed`. Cadence-aware and clamped to the medication's `createdAt`."),
    taken: z.number().int().nonnegative(),
    skipped: z
      .number()
      .int()
      .nonnegative()
      .describe("Doses the user explicitly skipped — excluded from the `rate` denominator."),
    missed: z.number().int().nonnegative(),
    rate: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("Adherence percentage `round(taken / (taken + missed) * 100)` — `skipped` is excluded from the denominator."),
    streak: z
      .number()
      .int()
      .nonnegative()
      .describe("Consecutive days with every due dose taken."),
  })
  .meta({
    id: "ComplianceResult",
    description:
      "Rolling-window adherence summary. `compliance30` is the authoritative 'last 30 days, taken vs expected' read — clients should display `rate` and use `totalExpected` as the denominator rather than re-deriving it from the daily map.",
  });

const dailyComplianceEntry = z
  .object({
    expected: z
      .number()
      .int()
      .nonnegative()
      .describe("Engine-computed due-slot count for the day. Equals `expectedCount`; kept for existing consumers."),
    expectedCount: z
      .number()
      .int()
      .nonnegative()
      .describe("True due-slot count for the day (additive field clients key off so they don't infer due-ness from `expected`)."),
    due: z
      .boolean()
      .describe("`expectedCount > 0`. Paint a per-day glyph as expected/missed ONLY when `due === true`; off-cadence / pre-creation / PRN days are not misses."),
    taken: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    onTime: z
      .number()
      .int()
      .nonnegative()
      .describe("Doses taken in the on-time band, including the `early` bucket (early counts as compliant)."),
    late: z.number().int().nonnegative(),
    veryLate: z.number().int().nonnegative(),
    early: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Doses taken before the on-time band's grace start; already folded into `onTime`, surfaced separately for consumers that differentiate."),
  })
  .meta({
    id: "DailyComplianceEntry",
    description:
      "Per-day compliance cell with the timing breakdown that drives the history glyph track.",
  });

const complianceDisplay = z
  .object({
    shortDays: z.number().int().positive(),
    longDays: z.number().int().positive(),
    expectedShort: z.number().int().nonnegative(),
    expectedLong: z.number().int().nonnegative(),
    minStableDoses: z.number().int().nonnegative(),
    short: z.object({
      rate: z.number().int().min(0).max(100),
      streak: z.number().int().nonnegative(),
    }),
    long: z.object({ rate: z.number().int().min(0).max(100) }),
    currentCycle: z
      .object({
        state: z
          .enum(["on_track", "due", "missed", "none"])
          .describe(
            "Open-cycle state, decoupled from the percentage rows: `on_track` = next dose not yet due; `due` = due now / in grace; `missed` = past grace with no logged intake (the only red state); `none` = no projected next dose (PRN / paused / ended).",
          ),
        nextDueAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe("The open cycle's due instant. Null when `state` is `none`."),
        graceUntil: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "End of the due slot's grace window. Null when `state` is `none`.",
          ),
        hasClosedCycles: z
          .boolean()
          .describe(
            "False for a brand-new sparse med with zero closed dose cycles — the percentage rows are vacuous and the card should show a neutral 'not enough data yet' state.",
          ),
      })
      .describe(
        "v1.13.x — the current (open) dose cycle, surfaced so a between-doses sparse med renders a neutral 'next dose in N days' line instead of a scary red 0%. The percentage rows above already exclude the open forward cycle from their denominator.",
      ),
  })
  .meta({
    id: "ComplianceDisplay",
    description:
      "The two-row card block whose windows scale with dosing cadence (dense meds keep 7 / 30 days, sparse meds step both windows up). NOT the 30-day denominator — read `compliance30.totalExpected` for that.",
  });

const medicationComplianceResponse = z
  .object({
    compliance7: complianceResult,
    compliance30: complianceResult,
    dailyCompliance: z
      .record(z.string(), dailyComplianceEntry)
      .describe("Flat per-day map keyed `YYYY-MM-DD` in the user timezone, one entry per day for up to 90 days back, clamped to the medication's `createdAt` (so a recently-created med has fewer entries). No weekly/monthly collapse — this is the raw daily grid."),
    complianceDisplay,
  })
  .meta({
    id: "MedicationComplianceResponse",
    description:
      "Adherence read for a single medication. `compliance30` is the authoritative 30-day taken-vs-expected summary; `dailyCompliance` is the per-day grid for the history glyph track. The graded raw→week→month→year series used elsewhere for AI prompts does NOT apply here — this response is never downsampled.",
  });

const insightsComprehensiveResponse = z
  .object({
    summary: z.string(),
    recommendations: z.array(z.record(z.string(), z.unknown())),
    citations: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.record(z.string(), z.unknown())),
    dailyBriefing: z.record(z.string(), z.unknown()).nullable().optional(),
    trendAnnotations: z.record(z.string(), z.unknown()).nullable().optional(),
    storyboardAnnotations: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    metricSource: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({
    id: "InsightsComprehensiveResponse",
    description:
      "AI-generated insights bundle. Strict-schema validated server-side; Coach-routed when the insight surface needs day-level grounding.",
  });

// v1.8.7.1 — generic per-HealthKit-metric assessment. The query enum is
// derived from the same registry the route validates against, so the
// spec, the route, and the cache scope cannot drift. The seven
// specialised metrics (weight / blood-pressure / pulse / bmi / mood /
// medication-compliance) keep their own routes and are NOT accepted here.
const metricStatusQuery = z
  .object({
    metric: z
      .enum(METRIC_STATUS_IDS as [string, ...string[]])
      .describe(
        "HealthKit metric id to assess (e.g. RESTING_HEART_RATE, SLEEP_DURATION). Closed enum: an unknown id 422s. The seven specialised metrics are served by their own routes and are not accepted here.",
      ),
    locale: z
      .enum(["de", "en"])
      .optional()
      .describe("Optional UI-locale override; defaults to the session locale."),
  })
  .meta({ id: "MetricStatusQuery" });

const metricStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `text` then carries the generic no-key guidance.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The assessment narrative (plain text, rendered as React text children). Null while a first generation is preparing, or when the metric has insufficient data.",
      ),
    cached: z
      .boolean()
      .describe("True when `text` is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior text exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when `text` is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The payload is otherwise terminal; the client keeps polling on `preparing || revalidating` (bounded) so the open card upgrades to the warmed assessment without a remount.",
      ),
    insufficient: z
      .boolean()
      .optional()
      .describe(
        "True when the metric has no readings; no assessment is generated (no LLM call). The card shows its insufficient-data state.",
      ),
  })
  .meta({
    id: "MetricStatusResponse",
    description:
      "Generic per-metric assessment envelope. Identical shape to the seven specialised `*-status` cards so the `InsightStatusCard` consumes it unchanged. Read-only + stale-while-revalidate: a cache miss warms a generation out of band and serves the last-good text meanwhile.",
  });

// v1.10.0 — generic derived-wellness-metric route. The query enum is
// derived from the same registry the route validates against, so spec +
// route + cache scope cannot drift. `type` sub-targets the single vital
// a baseline metric (VITALS_BASELINE) bands over.
const derivedMetricQuery = z
  .object({
    metric: z
      .enum(DERIVED_METRIC_IDS as [string, ...string[]])
      .describe(
        "Derived-metric id to compute (e.g. VITALS_BASELINE, FITNESS_AGE, VASCULAR_AGE_DELTA, HRV_BALANCE, BMI, READINESS). Closed enum: an unknown id 422s. Metrics whose compute has not yet landed return an `insufficient` value with reason `not_implemented`.",
      ),
    type: z
      .enum(VITALS_BASELINE_TYPES as [string, ...string[]])
      .optional()
      .describe(
        "For VITALS_BASELINE only — the single vital to band (defaults to RESTING_HEART_RATE). Ignored by composites. An unsupported value yields an `insufficient` value rather than a 422 so iOS metric combinations stay forgiving.",
      ),
  })
  .meta({ id: "DerivedMetricQuery" });

const derivedCoverage = z
  .object({
    requiredInputs: z
      .number()
      .int()
      .describe("Inputs the metric wants (its full input set)."),
    presentInputs: z
      .number()
      .int()
      .describe("Inputs actually present in the user's data."),
    historyDays: z
      .number()
      .int()
      .describe("Distinct days of history backing the value (the gating floor)."),
    missing: z
      .array(z.string())
      .describe("Named inputs still missing — drives the 'track N more' nudge."),
  })
  .meta({ id: "DerivedCoverage" });

const derivedConfidence = z
  .object({
    score: z
      .number()
      .describe("0..100 confidence; feeds the shared coverage meter unchanged."),
    band: z
      .enum(["high", "medium", "low", "draft"])
      .describe("Confidence band the meter renders."),
  })
  .meta({ id: "DerivedConfidence" });

const derivedProvenance = z
  .object({
    inputs: z
      .array(z.string())
      .describe("Named inputs that actually backed the value."),
    source: z
      .enum(["DAY", "WEEK", "MONTH", "YEAR", "live", "none"])
      .describe(
        "Granularity the dominant read resolved against. 'live' = a coverage-miss live-SQL fallback; 'none' = no data backed the value.",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Trailing window the value summarises, in days."),
    computedAt: z.iso
      .datetime({ offset: true })
      .describe("Compute time (for cache-staleness + the 'as of' chip)."),
  })
  .meta({ id: "DerivedProvenance" });

// v1.13.2 — per-derived-SCORE assessment text. Additive, non-breaking field
// on the derived response; the iOS field-name contract is LOCKED.
const derivedAssessment = z
  .object({
    text: z
      .string()
      .describe(
        "Short, non-empty explanation of why the score sits where it does, referencing the score's contributors.",
      ),
    source: z
      .string()
      .describe(
        "'deterministic' for the always-on template text, or 'ai' when warmer provider prose has been cached.",
      ),
    updatedAt: z.iso
      .datetime({ offset: true })
      .describe("When the text was produced / last warmed."),
  })
  .meta({ id: "DerivedAssessment" });

const derivedMetricResponse = z
  .object({
    metric: z
      .enum(DERIVED_METRIC_IDS as [string, ...string[]])
      .describe("Echoes the requested derived-metric id (tags the union)."),
    status: z
      .enum(["ok", "insufficient"])
      .describe(
        "'ok' carries `value` + `confidence`; 'insufficient' carries `reason` and no value, but still carries `coverage` + `provenance` so the surface renders the same gating UI.",
      ),
    value: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "Metric-specific value object when status is 'ok' (e.g. { type, center, low, high, spread, sampleDays, k, series } for VITALS_BASELINE, where `series` is the trailing per-day mean values for the inline sparkline); null when 'insufficient'.",
      ),
    coverage: derivedCoverage,
    confidence: derivedConfidence
      .nullable()
      .describe("Present when status is 'ok'; null when 'insufficient'."),
    provenance: derivedProvenance,
    reason: z
      .string()
      .nullable()
      .describe("Why the value could not be produced; null when status is 'ok'."),
    assessment: derivedAssessment
      .nullable()
      .describe(
        "v1.13.2 — short 'why is this score what it is' explanation, keyed to the SAME requested id (only for the per-score ids READINESS, SLEEP_SCORE, RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE). Null for any other metric and whenever status !== 'ok'. Always non-empty when present: a deterministic text fills it (so provider-less accounts + the demo always get one) and warmer AI prose overrides it once cached.",
      ),
  })
  .meta({
    id: "DerivedMetricResponse",
    description:
      "Flat `Derived<T>` envelope for one derived wellness metric. Pure compute over the rollup tier (no LLM, no narrative). iOS decodes one stable shape and combines values across metrics; coverage/confidence/provenance let it render the same honesty chips.",
  });

// v1.10.0 — batched derived-metric query. The `metrics` CSV carries one
// or more `metric` / `metric:type` tokens; the route fans out server-side
// under a bounded limiter with the profile loaded once, collapsing the
// dashboard's cold-mount fan-out of N single-metric requests into one.
const derivedBatchQuery = z
  .object({
    metrics: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Comma-separated derived-metric tokens. Each is a `<DERIVED_METRIC_ID>` or `<DERIVED_METRIC_ID>:<MeasurementType>` (the colon sub-targets a VITALS_BASELINE vital). An unknown id 422s; at most 24 tokens; duplicates collapse.",
      ),
  })
  .meta({ id: "DerivedBatchQuery" });

const derivedBatchResponse = z
  .object({
    metrics: z
      .record(z.string(), derivedMetricResponse)
      .describe(
        "Map keyed by the per-request token (`<metric>` or `<metric>:<type>`). Each value is the same flat `Derived<T>` envelope the single-metric route returns, so a client decodes one shape and reads back exactly the tokens it asked for.",
      ),
  })
  .meta({
    id: "DerivedBatchResponse",
    description:
      "Batched derived-metric values. One request resolves the whole dashboard grid (the wellness scores + the derived re-frames + one baseline per vital) instead of N concurrent single-metric requests sharing the Prisma pool. Pure compute over the rollup tier — no LLM, no narrative, no cache table.",
  });

// v1.10.0 — FDR-controlled correlation discovery result. One discovered,
// statistically-defensible behaviour → next-day-outcome pair.
const discoveredCorrelation = z
  .object({
    behaviour: z
      .string()
      .describe("Behaviour channel (lag source), e.g. TIME_IN_DAYLIGHT, MOOD."),
    outcome: z
      .string()
      .describe("Outcome channel (lag target), e.g. SLEEP_DURATION, HEART_RATE_VARIABILITY."),
    n: z.number().int().describe("Paired-day count after the day+1 lag join (≥ 20)."),
    r: z.number().describe("Pearson r over the lag-joined daily series."),
    pValue: z.number().describe("Two-sided exact Student-t p-value (< 0.05)."),
    qValue: z
      .number()
      .describe("Benjamini-Hochberg FDR-adjusted q-value (≤ the surface threshold)."),
    interpretation: z
      .string()
      .describe("Conservative, descriptive interpretation — never causal."),
    lagDays: z.number().int().describe("Lag in days applied (1)."),
  })
  .meta({ id: "DiscoveredCorrelation" });

const correlationDiscoveryResponse = z
  .object({
    discovered: z
      .array(discoveredCorrelation)
      .describe("Pairs surviving n ≥ 20, p < 0.05, AND the BH-FDR control."),
    pairsTested: z
      .number()
      .int()
      .describe("Behaviour × outcome pairs assessed (for the honest footer)."),
    fdrQ: z.number().describe("The FDR target the surface used."),
    minPairs: z.number().int().describe("Minimum paired-day count enforced per pair."),
  })
  .meta({
    id: "CorrelationDiscoveryResponse",
    description:
      "v1.10.0 — FDR-controlled correlation discovery over a curated behaviour × outcome matrix, lagged behaviour → next-day outcome. Only statistically-defensible pairs surface; descriptive, never causal.",
  });

// The seven specialised `*-status` routes accept an optional locale
// override (the metric is fixed by the route path, unlike the generic
// metric-status route which carries it as a query field).
const insightStatusQuery = z
  .object({
    locale: z
      .enum(["de", "en"])
      .optional()
      .describe("Optional UI-locale override; defaults to the session locale."),
  })
  .meta({ id: "InsightStatusQuery" });

// Shared response shape for the five text-bearing specialised status
// routes (blood-pressure, pulse, weight, bmi, mood). Same envelope as
// the generic metric-status card minus the `insufficient` flag, which is
// metric-status-only. Read-only + stale-while-revalidate.
const insightStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `text` then carries the generic no-key guidance.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The assessment narrative (plain text, rendered as React text children). Null while a first generation is preparing.",
      ),
    cached: z
      .boolean()
      .describe("True when `text` is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior text exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when `text` is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The client keeps polling on `preparing || revalidating` (bounded) so the open card upgrades to the warmed assessment without a remount.",
      ),
  })
  .meta({
    id: "InsightStatusResponse",
    description:
      "Specialised per-metric assessment envelope (blood-pressure, pulse, weight, bmi, mood). Identical shape to the generic metric-status card so the `InsightStatusCard` consumes it unchanged. Read-only + stale-while-revalidate: a cache miss warms a generation out of band and serves the last-good text meanwhile.",
  });

// The medication-compliance route carries a richer envelope than the
// other six: a `summary` narrative plus a per-medication `text` array,
// instead of a single `text` field.
const medicationComplianceStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `summary` then carries the generic no-key guidance.",
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        "The overall compliance narrative (plain text). Null while a first generation is preparing.",
      ),
    medications: z
      .array(
        z
          .object({
            medicationId: z
              .string()
              .describe("The medication this note belongs to."),
            text: z
              .string()
              .describe("Per-medication compliance note (plain text)."),
          })
          .meta({ id: "MedicationComplianceStatusItem" }),
      )
      .describe(
        "Per-medication compliance notes. Empty while preparing or when no medication qualifies.",
      ),
    cached: z
      .boolean()
      .describe("True when the envelope is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior summary exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when the envelope is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The client keeps polling on `preparing || revalidating` (bounded).",
      ),
  })
  .meta({
    id: "MedicationComplianceStatusResponse",
    description:
      "Medication-compliance assessment envelope. Unlike the other six specialised cards it carries a `summary` plus a per-medication `text` array rather than a single `text` field. Read-only + stale-while-revalidate.",
  });

const analyticsRangeQuery = z
  .object({
    type: measurementTypeEnum.describe(
      "The measurement type to read (single metric — no fan-out). Closed enum: an unknown type 422s.",
    ),
    range: z
      .enum(ANALYTICS_RANGES)
      .describe(
        "Trailing window: `7d` / `30d` / `90d` / `1y`. The previous comparable window is the equally-sized span immediately before it.",
      ),
  })
  .meta({ id: "AnalyticsRangeQuery" });

const analyticsWindowAggregate = z
  .object({
    count: z.number().int().describe("Reading count composed across buckets."),
    min: z.number().nullable().describe("Window minimum; null when empty."),
    max: z.number().nullable().describe("Window maximum; null when empty."),
    mean: z
      .number()
      .nullable()
      .describe("Count-weighted mean across buckets; null when empty."),
    sum: z
      .number()
      .nullable()
      .describe(
        "Cumulative total for cumulative metrics (steps, energy, distance); null when no bucket carries a sum.",
      ),
  })
  .meta({ id: "AnalyticsWindowAggregate" });

const analyticsRangeResponse = z
  .object({
    range: z
      .enum(ANALYTICS_RANGES)
      .describe("The range that was read (echoes the request)."),
    windowDays: z
      .number()
      .int()
      .describe("Trailing-window length in days for the chosen range."),
    granularity: z
      .string()
      .describe(
        "Rollup granularity the read resolved against (`DAY` / `WEEK` / `MONTH` / `YEAR`, or `none` on a coverage miss).",
      ),
    current: analyticsWindowAggregate.describe(
      "Aggregate over the current window `[now-N, now)`.",
    ),
    previous: analyticsWindowAggregate.describe(
      "Aggregate over the previous comparable window `[now-2N, now-N)`.",
    ),
    delta: z
      .number()
      .nullable()
      .describe(
        "`current.mean - previous.mean`; null when either window has no data (never a misleading 0).",
      ),
    deltaPct: z
      .number()
      .nullable()
      .describe(
        "`delta / previous.mean` as a fraction (0.03 = +3 %); null when the prior window has no / zero mean (no divide-by-zero). The client shows 'no prior-period data' in that case.",
      ),
  })
  .meta({
    id: "AnalyticsRangeResponse",
    description:
      "Single-metric period-over-period aggregate. Reads the current and previous comparable windows from the WMY rollup tier and composes a count-weighted-mean delta. `count/min/max/mean/sum` are linearly composable across buckets; SD/slope/r² are intentionally excluded (not composable).",
  });

const insightsPregenerateRequest = z
  .object({})
  .meta({
    id: "InsightsPregenerateRequest",
    description:
      "No body fields. The user is taken from the session / Bearer and the locale from the session; the warm covers every assessment for that user.",
  });

const insightsPregenerateResponse = z
  .object({
    queued: z
      .boolean()
      .describe("True when the full warm was accepted and enqueued."),
    locale: z
      .enum(["de", "en"])
      .describe("The locale the assessments are being warmed in."),
  })
  .meta({
    id: "InsightsPregenerateResponse",
    description:
      "Acknowledgement that a full assessment warm was enqueued for the calling user. The generation runs out of band; the text lands in the read-only status routes.",
  });

// v1.7.0 — unified dashboard first-paint snapshot. One GET that
// assembles every above-the-fold tile field in a single round-trip.
// Two-phase shape: `tiles` (fast, always present) + `extras` (thick,
// nullable on a rollup-coverage miss). The nested AI / DataSummary
// blocks are typed loosely (`z.record`) to match the comprehensive
// response style above — the strict shapes live in their own Zod
// modules and the iOS client does not consume this web-only route.
const dataSummaryRecord = z.record(z.string(), z.unknown());

const dashboardSnapshotResponse = z
  .object({
    user: z.object({
      username: z.string(),
      timezone: z.string(),
      heightCm: z.number().nullable(),
      dateOfBirth: z.string().nullable(),
      gender: z.enum(["MALE", "FEMALE"]).nullable(),
      glucoseUnit: z.string().nullable(),
      onboardingTourCompleted: z.boolean(),
      greetingHour: z.number().int(),
    }),
    layout: z.record(z.string(), z.unknown()),
    // v1.7.0 — full 27-id widget catalogue (16 server-known + 11
    // iOS-only) so a cold-launch first-paint seeds every tile and the
    // layout round-trips in one key. Additive alongside the web
    // `layout` block, which stays byte-identical.
    layoutCatalogue: z
      .array(
        z.object({
          id: z.string(),
          visible: z.boolean(),
          order: z.number().int(),
        }),
      )
      .describe(
        "Full 27-id widget catalogue (server-known + iOS-only) with per-widget visibility + order. iOS-only ids are appended default-invisible. The web dashboard reads `layout`; this block is the cold-launch seed for the native client.",
      ),
    // v1.7.0 — per-chartable-metric latest reading keyed by iOS
    // `MetricKind` raw value (e.g. `oxygenSaturation`,
    // `heartRateVariability`, `bodyMassIndex`). Derived in-process from
    // the slim summaries slice — no extra DB read.
    metricStates: z
      .record(
        z.string(),
        z.object({
          value: z.number(),
          measuredAt: z.string(),
          unit: z.string(),
        }),
      )
      .describe(
        "Latest reading per chartable metric, keyed by the iOS `MetricKind` raw value (the non-obvious raws: `oxygenSaturation`, `totalBodyWater`, `heartRateVariability`, `bodyMassIndex`, `walkingAsymmetryPercentage`, `walkingDoubleSupportPercentage`, `environmentalAudioExposure`, `headphoneAudioExposure`, `activeEnergyBurned`). Each entry carries `value`, `measuredAt` (ISO8601), and the canonical `unit`. Types the user has never logged are omitted.",
      ),
    tiles: z.object({
      summaries: dataSummaryRecord,
      lastSeenByType: z.record(z.string(), z.unknown()),
      mood: z.object({
        summary: dataSummaryRecord.nullable(),
        entries: z.array(
          z.object({
            date: z.string(),
            score: z.number(),
            samples: z.number().int(),
          }),
        ),
      }),
    }),
    extras: z
      .object({
        bpInTargetPct: z.number().nullable(),
        bpInTargetPct7d: z.number().nullable(),
        bpInTargetPct30d: z.number().nullable(),
        bpInTargetPctAllTime: z.number().nullable(),
        bpInTargetPctPriorMonth: z.number().nullable(),
        bpInTargetPctPriorYear: z.number().nullable(),
        glucoseByContext: dataSummaryRecord,
      })
      .nullable(),
    briefing: z.record(z.string(), z.unknown()).nullable(),
    briefingState: z.enum(["ready", "preparing", "disabled"]),
    briefingUpdatedAt: z.string().nullable(),
    generatedAt: z.string(),
  })
  .meta({
    id: "DashboardSnapshotResponse",
    description:
      "Unified above-the-fold dashboard payload. `tiles` always arrives (slim summaries + mood + resolved widget layout); `extras` (BD-in-target + per-context glucose) is null on a rollup-coverage miss so the strip never waits on the slowest read. `briefing` is lifted read-only from the pre-generated insight cache — never generated synchronously — and reports `ready` / `preparing` / `disabled` via `briefingState`. `layoutCatalogue` (full 27-id widget catalogue) and `metricStates` (latest reading per metric, keyed by iOS `MetricKind` raw value) are additive cold-launch seeds for the native client; both derive in-process from data already fetched, adding no DB round-trip.",
  });

// v1.5.0 — natural-language medication extraction route. The wizard's
// optional "Beschreiben" overlay POSTs a free-text description and
// receives a partial structured payload the form merges onto whatever
// the user already typed. Citation-guarded (`name` and `dose` are
// dropped when not substring-matched in the original text) and
// closed-enum-validated.
const medicationExtractRequest = z
  .object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Free-text medication description (any locale). Up to 2 000 characters. The model never echoes the text back into another tenant — it is only used to produce the structured fields.",
      ),
    locale: z
      .enum(["en", "de", "es", "fr", "it", "pl"])
      .optional()
      .describe("Optional UI locale hint for the model."),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Optional override of the reference date used to resolve relative phrases (\"tomorrow\", \"next Monday\"). Format: `YYYY-MM-DD`. Defaults to the server's UTC day.",
      ),
  })
  .meta({
    id: "MedicationExtractRequest",
    description:
      "Free-text medication description payload. The route runs the text through the Coach provider chain and returns a partial structured payload the wizard merges. Rate-limited 10 requests / 5 minutes / user; budget-gated against the daily Coach token ceiling.",
  });

medicationExtractionSchema.meta({
  id: "MedicationExtractionResult",
  description:
    "Citation-guarded partial extraction of medication scheduling fields. Every field is optional; the wizard merges what is present onto the form state and leaves the rest blank. `name` and `dose` are post-validated against the original free-text and dropped when not substring-matched, so the wizard cannot silently land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped to the wizard's wire bounds.",
});

// Insights tile layout — mirrors the Zod schema in
// `src/app/api/insights/layout/route.ts`. The tile-id enum is derived
// from the same `ACCEPTED_INSIGHTS_TILE_IDS` source so the contract
// cannot drift.
//
// v1.8.0 — the canonical ids are English (`blood-pressure`, `pulse`,
// `oxygen`, `body-temperature`, `weight`, `active-energy`, `sleep`,
// `resting-pulse`, `mood`, `medications`). The endpoint still ACCEPTS
// the legacy German ids (`blutdruck`, `puls`, `sauerstoff`,
// `koerpertemperatur`, `gewicht`, `aktive-energie`, `schlaf`,
// `ruhepuls`, `stimmung`, `medikamente`) on input so existing iOS
// layouts keep validating; the server normalises them to the canonical
// English id before persisting, and GET always returns canonical ids.
// The legacy ids are accepted-but-deprecated and will be dropped from
// the accepted set in a future major.
const insightsLayoutSchema = z
  .object({
    version: z.literal(1),
    tiles: z
      .array(
        z.object({
          id: z.enum(ACCEPTED_INSIGHTS_TILE_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .min(1)
      .max(50),
  })
  .meta({
    id: "InsightsLayoutBody",
    description:
      "Per-user Insights tile layout: an ordered list of tiles with a visibility flag. `version` is the layout schema version. Tile ids are a closed enum: the canonical ids are English (matching the routed `/insights/<slug>` sub-pages). The legacy German ids (blutdruck, puls, sauerstoff, koerpertemperatur, gewicht, aktive-energie, schlaf, ruhepuls, stimmung, medikamente) remain accepted on input for backward compatibility and are normalised to their English equivalents before persisting; GET responses always carry the canonical English ids. The legacy ids are deprecated and will be removed in a future major version.",
  });

// v1.7.0 — health-record export selection. Strict shape: unknown keys
// (including any attempt to smuggle a userId) 422 via returnAllZodIssues.
// v1.11.0 — clinician share-link create payload. Strict; no `userId` field
// (the owner is always narrowed from the session/Bearer). `expiresAt` is
// required and capped at SHARE_LINK_MAX_DAYS; the scope columns are frozen
// write-once at creation.
createShareLinkSchema.meta({
  id: "CreateShareLinkRequest",
  description:
    "v1.11.0 — owner request to mint a clinician share link to their own health record. `expiresAt` is required (absolute ISO instant) and capped at 90 days. `rangeStart`/`rangeEnd` freeze the reporting window (rangeEnd null = rolling). `resourceTypes` scopes the FHIR resources the link may serve; `allowFhirApi` toggles REST reachability. Strict: unknown keys 422.",
});

exportSelectionSchema.meta({
  id: "HealthRecordExportRequest",
  description:
    "v1.7.0 — health-record / doctor-handover export selection. `format` picks PDF, FHIR R4 document Bundle, or a combined zip package. Grouped `sections` toggles drive which domains are read (mood is opt-in, off by default). No `userId` field — the user is always narrowed from the session/Bearer. The route is strict: unknown keys 422.",
});

// v1.11.0 — clinician share-link owner-facing summary (never the raw token).
const shareLinkSummary = z.object({
  id: z.string(),
  label: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string().nullable(),
  resourceTypes: z.array(z.string()),
  allowFhirApi: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  lastAccessAt: z.string().nullable(),
  accessCount: z.number(),
  active: z.boolean(),
});

const shareLinkCreatedResponse = shareLinkSummary.extend({
  token: z
    .string()
    .describe("Raw `hls_` token — returned ONCE and unrecoverable thereafter."),
});

const shareLinkListResponse = z.object({
  shareLinks: z.array(shareLinkSummary),
});

const shareLinkRevokedResponse = z.object({
  id: z.string(),
  revoked: z.boolean(),
});

// v1.10.2 — live capability / discovery response. Every list is sourced
// server-side from the canonical registry it documents, so the wire shape
// here is the contract; the runtime values are authoritative and never
// hand-duplicated. Used by the native client to gate its UI / decoder
// against what the server actually ships (retires the doc-vs-server
// enum-drift class).
const capabilitiesResponse = z
  .object({
    apiContractVersion: z
      .string()
      .describe("Running build version — mirrors GET /api/version `version`."),
    derivedMetricIds: z
      .array(z.string())
      .describe("Closed derived-metric id set (GET /api/insights/derived)."),
    vitalsBaselineTypes: z
      .array(z.string())
      .describe("MeasurementTypes the typical-range baseline engine supports."),
    layoutTileIds: z
      .array(z.string())
      .describe("Canonical insights layout tile-id set (English ids)."),
    metricStatusIds: z
      .array(z.string())
      .describe("Closed metric-status / assessment id set."),
    ingest: z
      .object({
        quantityTypes: z
          .array(
            z.object({
              type: z.string().describe("HealthLog MeasurementType."),
              hk: z.string().describe("HealthKit identifier."),
              unit: z.string().describe("Canonical DB unit."),
            }),
          )
          .describe("Accepted HealthKit quantity-sample mappings."),
        eventTypes: z
          .array(z.string())
          .describe(
            "MeasurementTypes for device-flagged EVENT-class HealthKit samples.",
          ),
        computedScores: z
          .array(z.string())
          .describe("Server-owned nightly composite score types."),
        writeAllowlist: z
          .array(z.string())
          .describe(
            "MeasurementSources a client may attribute on a write (others are server-owned).",
          ),
      })
      .describe("Ingest vocabularies the batch / single-write paths accept."),
    fhir: z
      .object({
        atcSystem: z.string().describe("WHO ATC CodeSystem URI."),
        snomedRoute: z.string().describe("SNOMED CT CodeSystem URI."),
        germanAtcDefaultLocales: z
          .array(z.string())
          .describe("App locales that default the additive BfArM ATC coding on."),
        restBaseUrl: z
          .string()
          .describe("Base path of the read-only FHIR R4 REST face."),
        readScope: z
          .string()
          .describe("Bearer scope a narrow token needs to read the FHIR face."),
        resourceTypes: z
          .array(z.string())
          .describe("FHIR resource types the REST face serves (read + search)."),
        operations: z
          .array(z.string())
          .describe("Whole-record operations exposed (e.g. $everything)."),
        searchParams: z
          .array(z.string())
          .describe("Search parameters honoured uniformly across the search routes."),
      })
      .describe(
        "FHIR coding constants + the read-only REST face descriptor (v1.11).",
      ),
    share: z
      .object({
        supported: z.boolean().describe("Whether clinician share links are served."),
        maxDays: z
          .number()
          .int()
          .describe("Maximum lifetime of a share link, in days. No never-expiring share."),
        resourceTypes: z
          .array(z.string())
          .describe("FHIR resource types a share link may be scoped to serve."),
        sections: z
          .array(z.string())
          .describe("Scopeable report sections a share link may toggle."),
      })
      .describe("Clinician share-link surface descriptor (v1.11)."),
  })
  .meta({
    id: "CapabilitiesResponse",
    description:
      "Live id vocabularies + contract version. Every list is derived server-side from the canonical registry it documents, so it cannot drift from the values the routes actually accept/emit.",
  });

// ── Standard 401 / 422 / 429 responses ───────────────────────────────

const stdResponses = {
  "401": {
    description: "Authentication required or invalid credentials.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "422": {
    description: "Request validation failed.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "429": {
    description: "Rate limit exceeded.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

// ── Coach facts (v1.11.1) ────────────────────────────────────────────
// Read + delete surface for the durable facts the Coach extracts. Facts
// are server-extracted, not user-authored, so there is no create/update
// shape — only list, bulk-clear, and single-delete responses.

const coachFactItem = z.object({
  id: z.string(),
  category: z
    .enum(COACH_FACT_CATEGORIES)
    .describe(
      "App-side closed category: preference | condition | goal | constraint | context.",
    ),
  text: z.string().describe("Decrypted fact text."),
  confidence: z
    .number()
    .int()
    .describe("0..100 server-assigned extraction confidence."),
  createdAt: z.iso.datetime({ offset: true }),
});

const coachFactsListResponse = z.object({
  facts: z
    .array(coachFactItem)
    .describe(
      "The caller's active facts, highest-confidence then newest first. Undecryptable rows are omitted.",
    ),
});

const coachFactsClearedResponse = z.object({
  cleared: z
    .number()
    .int()
    .describe("Number of active facts soft-deleted by the bulk clear."),
});

const coachFactDeletedResponse = z.object({
  deleted: z
    .boolean()
    .describe(
      "True when a fact owned by the caller was soft-deleted; false for an unknown / cross-user / already-deleted id (idempotent no-op).",
    ),
});

// ── Cycle tracking (v1.15.0) ─────────────────────────────────────────
// The `/api/cycle/*` capture / calendar / history / settings surface +
// the cycle-prefs PATCH. Request bodies come from the Zod validation
// module so the spec stays single-source; response DTOs are declared
// here mirroring `src/lib/cycle/dto.ts`. Every `/api/cycle/*` route also
// 403s `{ errorCode:"cycle.disabled" }` when the feature gate is off.

const predictionMethodEnumOpenapi = z
  .enum(["CALENDAR", "SYMPTOTHERMAL", "TEMPERATURE_TREND", "BLENDED"])
  .meta({ id: "CyclePredictionMethod" });

const cyclePhaseEnumOpenapi = z
  .enum(["MENSTRUAL", "FOLLICULAR", "OVULATORY", "LUTEAL"])
  .meta({ id: "CyclePhase" });

flowLevelEnum.meta({ id: "FlowLevel", description: "Menstrual-flow intensity." });
ovulationTestEnum.meta({
  id: "OvulationTest",
  description: "Ovulation predictor-kit (OPK) reading.",
});
cervicalMucusEnum.meta({ id: "CervicalMucus", description: "Cervical-mucus quality." });
homeTestResultEnum.meta({
  id: "HomeTestResult",
  description: "At-home test result (pregnancy / progesterone).",
});
cycleTrackingGoalEnum.meta({
  id: "CycleTrackingGoal",
  description: "Drives cycle copy + fertile-window gating.",
});

cycleDayLogInputSchema.meta({
  id: "CycleDayLogInput",
  description:
    "One day's cycle capture. `note` is encrypted at rest; every other field is queryable plaintext. UPSERT key: `(userId, source, externalId)` when externalId present, else `(userId, date)`. Shared by the single POST, the bulk drain, and the period shortcut.",
});

cycleBulkSchema.meta({
  id: "CycleDayLogBulkRequest",
  description:
    "Outbox / HealthKit drain. Up to 500 entries per call; wrapped in `withIdempotency`; rate-limited 60/min. Each entry upserts per the day-log key.",
});

cyclePeriodSchema.meta({
  id: "CyclePeriodRequest",
  description:
    "One-tap period boundary. `start` opens a new cycle (closing the prior), `end` stamps the current cycle's periodEndDate; both write a boundary day-log.",
});

cyclePrefsSchema.meta({
  id: "CyclePrefsRequest",
  description:
    "Partial cycle-preferences deep-merge. `enabled` flips the feature gate (`cycleTrackingEnabled`). Omitted fields are left untouched.",
});

cycleDayLogPatchSchema.meta({
  id: "CycleDayLogPatchRequest",
  description:
    "Partial day-log edit. Every field optional; `note` re-encrypts (explicit null clears it). `date` / `source` / `externalId` are immutable on update.",
});

const cycleSymptomDto = z.object({
  key: z.string(),
  severity: z.number().int().min(1).max(4).nullable(),
});

const cycleDayLogDto = z
  .object({
    id: z.string(),
    date: z.string(),
    cycleId: z.string().nullable(),
    flow: flowLevelEnum.nullable(),
    intermenstrualBleeding: z.boolean(),
    basalBodyTempC: z.number().nullable(),
    ovulationTest: ovulationTestEnum.nullable(),
    cervicalMucus: cervicalMucusEnum.nullable(),
    sexualActivity: z.boolean(),
    protectedSex: z.boolean().nullable(),
    pregnancyTest: homeTestResultEnum.nullable(),
    progesteroneTest: homeTestResultEnum.nullable(),
    contraceptive: z.string().nullable(),
    symptoms: z.array(cycleSymptomDto),
    note: z.string().nullable(),
    source: z.string(),
    externalId: z.string().nullable(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
    deletedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({
    id: "CycleDayLogDTO",
    description:
      "The canonical day-log row iOS mirrors. `note` is decrypted on read. Soft-deleted rows ride `/api/sync/changes` as tombstones.",
  });

const menstrualCycleDto = z
  .object({
    id: z.string(),
    startDate: z.string(),
    endDate: z.string().nullable(),
    periodEndDate: z.string().nullable(),
    lengthDays: z.number().int().nullable(),
    ovulationDate: z.string().nullable(),
    ovulationConfirmed: z.boolean(),
    isPredicted: z.boolean(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MenstrualCycleDTO",
    description: "One menstrual cycle (observed or forward-predicted).",
  });

const cyclePredictionDto = z
  .object({
    method: predictionMethodEnumOpenapi,
    nextPeriodStart: z.string(),
    nextPeriodStartLow: z.string(),
    nextPeriodStartHigh: z.string(),
    fertileWindowStart: z.string().nullable(),
    fertileWindowEnd: z.string().nullable(),
    predictedOvulation: z.string().nullable(),
    confidence: z.number(),
    cyclesObserved: z.number().int(),
    stillLearning: z.boolean(),
    disclaimer: z.string(),
  })
  .meta({
    id: "CyclePredictionDTO",
    description:
      "The materialised forecast. Fertile-window fields are server-suppressed (null) unless the goal is TRYING_TO_CONCEIVE.",
  });

const cycleCalendarDayDto = z.object({
  date: z.string(),
  phase: cyclePhaseEnumOpenapi.nullable(),
  isPredictedPeriod: z.boolean(),
  isFertileWindow: z.boolean(),
  isPredictedOvulation: z.boolean(),
  isPeriodLogged: z.boolean(),
  flow: flowLevelEnum.nullable(),
  hasSymptoms: z.boolean(),
  confidence: z.number(),
});

const cycleProfileDto = z
  .object({
    goal: cycleTrackingGoalEnum,
    cycleTrackingEnabled: z.boolean(),
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    discreetNotifications: z.boolean(),
    sensitiveCategoryEncryption: z.boolean(),
    typicalCycleLength: z.number().int().nullable(),
    typicalPeriodLength: z.number().int().nullable(),
    lutealPhaseLength: z.number().int().nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "CycleProfileDTO",
    description: "The full per-user cycle settings row.",
  });

const cycleCalendarResponse = z.object({
  profile: z.object({
    goal: cycleTrackingGoalEnum,
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    cyclesObserved: z.number().int(),
  }),
  prediction: cyclePredictionDto.nullable(),
  days: z.array(cycleCalendarDayDto),
  meta: z.object({ generatedAt: z.iso.datetime({ offset: true }) }),
});

const cycleHistoryResponse = z.object({
  cycles: z.array(menstrualCycleDto),
  stats: z.object({
    avgLengthDays: z.number().int().nullable(),
    lengthVariabilityDays: z.number().nullable(),
    avgPeriodLengthDays: z.number().int().nullable(),
    regularity: z.enum(["REGULAR", "IRREGULAR", "LEARNING"]),
  }),
});

const cyclePeriodResponse = z.object({
  cycle: menstrualCycleDto.nullable(),
  dayLog: cycleDayLogDto.nullable(),
});

const cyclePhaseCrosstabRow = z
  .object({
    metricKey: z.enum([
      "restingHeartRate",
      "heartRateVariability",
      "sleepDuration",
      "steps",
      "weight",
      "basalBodyTemp",
      "wristTemperature",
      "skinTemperature",
    ]),
    display: z.enum(["hours", "steps", "bpm", "ms", "kg", "celsius"]),
    lutealDays: z.number().int(),
    follicularDays: z.number().int(),
    lutealAvg: z.number(),
    follicularAvg: z.number(),
    delta: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .meta({
    id: "CyclePhaseCrosstabRow",
    description:
      "One FDR-surviving luteal-vs-follicular contrast for an outcome metric. `delta = lutealAvg − follicularAvg`. Observational, never causal.",
  });

const cyclePhaseLaggedPair = z
  .object({
    behaviour: z.string(),
    outcome: z.string(),
    n: z.number().int(),
    r: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    interpretation: z.string(),
    lagDays: z.number().int(),
  })
  .meta({
    id: "CyclePhaseLaggedPair",
    description:
      "One FDR-surviving lagged-Pearson pair from the continuous CYCLE_PHASE ordinal × outcome matrix (mechanism B). Descriptive, never causal.",
  });

const cycleInsightsResponse = z.object({
  rows: z.array(cyclePhaseCrosstabRow),
  headline: cyclePhaseCrosstabRow.nullable(),
  lagged: z.object({
    discovered: z.array(cyclePhaseLaggedPair),
    pairsTested: z.number().int(),
    fdrQ: z.number(),
    minPairs: z.number().int(),
  }),
  contrast: z.object({
    high: z.literal("LUTEAL"),
    low: z.literal("FOLLICULAR"),
  }),
  windowDays: z.number().int(),
  cyclesObserved: z.number().int(),
});

const cycleBulkEntryResult = z.object({
  index: z.number().int(),
  status: z.enum(["inserted", "duplicate", "updated", "skipped"]),
  id: z.string().optional(),
  externalId: z.string().optional(),
  reason: z.string().optional(),
});

const cycleBulkResponse = z.object({
  processed: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  duplicates: z.number().int(),
  skipped: z.number().int(),
  entries: z.array(cycleBulkEntryResult),
});

// A reusable 403 the cycle routes carry (the feature gate).
const cycleDisabledResponse = {
  "403": {
    description:
      "Cycle tracking is not enabled for this account (errorCode `cycle.disabled`).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

// ── Path table ───────────────────────────────────────────────────────

export const openApiPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/cycle/day-logs": {
    get: {
      tags: ["Cycle"],
      summary: "Read a single day's cycle day-log (v1.15.0)",
      description:
        "Returns the full `CycleDayLogDTO` for the tz-anchored `date`, or `null` when nothing is logged that day. Lets a client pre-fill an edit sheet. Gated; owner-scoped; soft-deleted rows excluded.",
      requestParams: { query: cycleDayLogQuerySchema },
      responses: {
        "200": {
          description: "The day-log for that date, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleDayLogDto.nullable(),
                "CycleDayLogReadEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Cycle"],
      summary: "Capture a single cycle day-log (v1.15.0)",
      description:
        "Upserts on `(userId, source, externalId)` when externalId present, else `(userId, date)`. `note` encrypts at rest. 201 on insert, 200 on update. Gated: `cycle.disabled` 403 when the feature is off.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogInputSchema } },
      },
      responses: {
        "200": {
          description: "Existing day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogEnvelope"),
            },
          },
        },
        "201": {
          description: "New day-log created.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogCreatedEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/day-logs/{id}": {
    patch: {
      tags: ["Cycle"],
      summary: "Edit a single cycle day-log (v1.15.0)",
      description:
        "Partial edit; an omitted field is left untouched. Owner-scoped (a cross-user id 404s). Gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogPatchSchema } },
      },
      responses: {
        "200": {
          description: "Day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogPatchEnvelope"),
            },
          },
        },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a cycle day-log (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; surfaces as a tombstone on the next `/api/sync/changes` page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/day-logs/bulk": {
    post: {
      tags: ["Cycle"],
      summary: "Bulk drain cycle day-logs (Outbox / HealthKit) (v1.15.0)",
      description:
        "Up to 500 entries; `withIdempotency`; rate-limited `cycle:day-logs:bulk:<userId>` 60/min. Per-entry status: inserted | duplicate | updated | skipped. Always 200.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleBulkSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed (per-entry results).",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleBulkResponse, "CycleBulkEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/period": {
    post: {
      tags: ["Cycle"],
      summary: "Period-boundary shortcut (v1.15.0)",
      description:
        "One-tap started/ended period. `start` opens a new cycle (closing the prior); `end` stamps periodEndDate. Writes the boundary day-log. Gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePeriodSchema } },
      },
      responses: {
        "200": {
          description: "Cycle + boundary day-log.",
          content: {
            "application/json": {
              schema: dataEnvelope(cyclePeriodResponse, "CyclePeriodEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/calendar": {
    get: {
      tags: ["Cycle"],
      summary: "Predicted cycle calendar (v1.15.0)",
      description:
        "Runs the deterministic engine to build `{ profile, prediction, days }`. Fertile-window fields are server-suppressed unless goal is TRYING_TO_CONCEIVE. Default range: today − 90d … +180d. Gated.",
      requestParams: {
        query: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Calendar grid + forecast.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleCalendarResponse, "CycleCalendarEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle history + stats (v1.15.0)",
      description:
        "Most-recent cycles (newest first) + `{ avgLengthDays, lengthVariabilityDays (MAD), avgPeriodLengthDays, regularity }`. `limit` default 24. Gated.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(60).optional(),
        }),
      },
      responses: {
        "200": {
          description: "Cycle history.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleHistoryResponse, "CycleHistoryEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/insights": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle-phase correlation insights (v1.15.0)",
      description:
        "FDR-guarded luteal-vs-follicular phase contrast per outcome metric (RHR / HRV / sleep / steps / weight / temperatures), plus the single headline finding (resting-heart-rate-by-phase, falling back to HRV). The same Welch t-test + Benjamini-Hochberg machinery the mood-factor crosstab runs; only rows with p < 0.05 AND q ≤ 0.10 surface. Strictly gender-gated — phase never appears on the general `/api/insights/correlations` route. Observational only, never causal. Gated: `cycle.disabled` 403 when the feature is off.",
      responses: {
        "200": {
          description: "Phase-correlation rows + headline.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleInsightsResponse, "CycleInsightsEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles/{id}": {
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a menstrual cycle (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; tombstones on the next sync page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Cycle not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/profile": {
    get: {
      tags: ["Cycle"],
      summary: "Read the full cycle profile (v1.15.0)",
      description: "Returns the resolved CycleProfileDTO. Gated.",
      responses: {
        "200": {
          description: "Cycle profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CycleProfileEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/cycle-prefs": {
    get: {
      tags: ["Cycle"],
      summary: "Read cycle preferences (v1.15.0)",
      description:
        "Returns the resolved CycleProfileDTO. NOT gated — this is the surface that flips the gate.",
      responses: {
        "200": {
          description: "Cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsGetEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Cycle"],
      summary: "Update cycle preferences (v1.15.0)",
      description:
        "Deep-merges the supplied fields. `enabled` flips `cycleTrackingEnabled`. Returns the merged CycleProfileDTO. NOT gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePrefsSchema } },
      },
      responses: {
        "200": {
          description: "Merged cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsPatchEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/meta/capabilities": {
    get: {
      tags: ["Meta"],
      summary: "Live server capability / id-vocabulary discovery",
      description:
        "Returns the server's REAL id vocabularies (derived-metric ids, vitals-baseline types, layout tile-ids, metric-status ids, the HealthKit ingest mapping, the FHIR coding constants) plus the running API contract version. Every list is derived server-side from the canonical registry it documents, so a client can gate its UI / decoder against what the server actually ships rather than a hand-maintained copy. Auth via cookie or Bearer (not admin).",
      responses: {
        "200": {
          description: "Capability snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                capabilitiesResponse,
                "CapabilitiesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/export/health-record": {
    post: {
      tags: ["Export"],
      summary: "Generate a health-record export (PDF / FHIR / package)",
      description:
        "v1.7.0 flagship export. Returns the doctor-handover artefact in the requested `format`: `pdf` → application/pdf, `fhir` → application/fhir+json (HL7 FHIR R4 document Bundle), `package` → application/zip (PDF + FHIR + README). Auth via cookie or Bearer; shared `export:<userId>` rate bucket (10/h). Strict validation: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: exportSelectionSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Export generated. Content-Type varies by `format`: application/pdf, application/fhir+json, or application/zip.",
          content: {
            "application/pdf": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/zip": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links": {
    post: {
      tags: ["Export"],
      summary: "Create a clinician share link (v1.11.0)",
      description:
        "Owner-only. Mints an `hls_` token (192-bit), stores only its HMAC hash, and returns the raw token EXACTLY ONCE in the response. Every scope column (window, sections, FHIR resource types, API toggle) is frozen write-once. `expiresAt` is required and capped at 90 days. Auth via cookie or Bearer; rate-limited (`share-link:<userId>`, 20/h). Strict: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createShareLinkSchema },
        },
      },
      responses: {
        "201": {
          description:
            "Share link created. `token` carries the raw `hls_` value and is unrecoverable after this response.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkCreatedResponse, "ShareLinkCreated"),
            },
          },
        },
        ...stdResponses,
      },
    },
    get: {
      tags: ["Export"],
      summary: "List own clinician share links (v1.11.0)",
      description:
        "Owner-only. Returns the caller's own share links (never the raw token — it is unrecoverable after creation). Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Share links owned by the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkListResponse, "ShareLinkList"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links/{id}": {
    delete: {
      tags: ["Export"],
      summary: "Revoke a clinician share link (v1.11.0)",
      description:
        "Owner-only. Sets `revokedAt` on the caller's own link. A cross-user or unknown id is sealed as 404. Auth via cookie or Bearer; rate-limited.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Link revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkRevokedResponse, "ShareLinkRevoked"),
            },
          },
        },
        "404": {
          description: "Link not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/metadata": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 CapabilityStatement (v1.11.0)",
      description:
        "Read-only FHIR R4 capability statement for the REST face. Declares the served resource types (Patient, Observation, MedicationStatement, MedicationAdministration), the `$everything` operation, and the `application/fhir+json` format. Auth: `fhir:read` scope (cookie sessions also pass).",
      responses: {
        "200": {
          description: "CapabilityStatement (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Patient": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Patient search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Patient resource. Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`. `userId` is narrowed from auth.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Observation": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Observation search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Observations (vitals / activity / lab / survey). Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationStatement": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationStatement search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own active-medication statements. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationAdministration": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationAdministration search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own acted intakes (completed / not-done). Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/$everything": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 $everything (v1.11.0)",
      description:
        "Read-only `$everything` operation: every resource in the caller's own record (Patient, Coverage, Observations, MedicationStatements, MedicationAdministrations) in one `searchset` Bundle. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Email-or-username login (password)",
      description:
        "Browser callers receive a session cookie. Native callers (X-Client-Type: native or HealthLog-iOS UA prefix) additionally receive a paired access + refresh token.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: loginPasswordSchema } },
      },
      responses: {
        "200": {
          description: "Login succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "LoginResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkey/login-verify": {
    post: {
      tags: ["Auth"],
      summary: "Passkey assertion verification",
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyLoginVerifyRequest } },
      },
      responses: {
        "200": {
          description: "Assertion verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "PasskeyLoginVerifyResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate refresh token (one-time use)",
      description:
        "Reuse of a consumed refresh token revokes every refresh token still active for the originating device (per-device blast radius from v1.4.23). Legacy tokens issued before v1.4.23 with a null deviceId fall back to revoke-all-for-user.\n\n" +
        "On a 401, `meta.errorCode` is a stable machine code so the client can branch terminal re-auth from a transient blip without parsing the prose `error`: `auth.refresh.reuse` (a consumed token was replayed — device family revoked, re-pair required), `auth.refresh.revoked` (family revoked out-of-band — re-pair required), `auth.refresh.invalid` (not found / expired — drop the token and re-authenticate).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: refreshRequest } },
      },
      responses: {
        "200": {
          description: "Rotation succeeded — new pair issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "RefreshResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sync/state": {
    get: {
      tags: ["Sync"],
      summary: "Sync handshake + window metadata",
      description:
        "Cheap 'should I sync?' summary. Returns the previous `lastSyncedAt` checkpoint and advances it server-side on each call. The `sync` block carries the incremental-delta window + tombstone retention so the client reads them rather than hardcoding.",
      responses: {
        "200": {
          description: "Sync state summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncStateResponse, "SyncStateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/sync/changes": {
    get: {
      tags: ["Sync"],
      summary: "Measurements delta feed",
      description:
        "Incremental catch-up after the first-pair backfill (never a replacement for it). Pages over an opaque keyset cursor; each page carries `tombstones` (soft-deleted rows, keyed on `externalId`) and `upserts` (live rows). Apply tombstones before upserts within a page. `cursorExpired: true` forces a clean re-init.",
      requestParams: {
        query: syncChangesQuery,
      },
      responses: {
        "200": {
          description: "Delta page.",
          content: {
            "application/json": {
              schema: dataEnvelope(syncChangesResponse, "SyncChangesEnvelope"),
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
        ...stdResponses,
      },
    },
  },
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
  "/api/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register native device + APNs token",
      description:
        "Idempotent upsert by `token`. APNs token + environment are paired — supplying one without the other returns 422. Cross-user re-registration of either identifier returns 409.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deviceRegisterRequest } },
      },
      responses: {
        "201": {
          description: "Device registered or refreshed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string() }),
                "DeviceRegisterResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "Device or APNs token already registered to another user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications": {
    get: {
      tags: ["Medications"],
      summary: "List medications for the calling user",
      description:
        "Returns every medication owned by the caller (active + paused), ordered by `createdAt DESC`. Each row carries its nested `schedules`, the joined clinical `category`, the latest non-skipped `lastTakenAt`, and the count of intake events scheduled for today (`todayEventCount`). The response is cached server-side for 60 s per user; writes flush the cache.",
      responses: {
        "200": {
          description: "Medication list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationListEntry),
                "ListMedicationsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Create a medication with at least one schedule",
      description:
        "Validates the body against `CreateMedicationRequest`, applies the v1.5 cross-field invariants (one-shot consistency, recurring default `FREQ=DAILY`, `timesOfDay` dual-write), and creates the medication + its schedules in a single Prisma write. Audits as `medication.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMedicationSchema } },
      },
      responses: {
        "201": {
          description: "Created medication with its schedules.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "CreateMedicationResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}": {
    get: {
      tags: ["Medications"],
      summary: "Fetch a single medication",
      description:
        "Returns the medication + its schedules + the joined `category`. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Medication detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "GetMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Replace a medication (partial fields)",
      description:
        "Every field on the body is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false stamps `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match `POST /api/medications`. Audits as `medication.update`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMedicationSchema } },
      },
      responses: {
        "200": {
          description: "Updated medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "UpdateMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a medication",
      description:
        "Cascades to the medication's schedules, intake events, dose changes, inventory rows, and side-effect logs. Revokes every API token scoped to `medication:<id>:ingest`. Audits as `medication.delete`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/intake": {
    post: {
      tags: ["Medications"],
      summary: "Log an intake event for a medication",
      description:
        "Records a taken or skipped dose. Idempotent via the `Idempotency-Key` header AND the optional `idempotencyKey` body field (the route walks both paths); a re-post inside the 60 s server-side dedup window returns the original event. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for `oneShot:true` medications — flip `active` to false.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: intakeSchema } },
      },
      responses: {
        "201": {
          description: "Intake event created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "CreateMedicationIntakeResponse",
              ),
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — the original event is returned without creating a new row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "ReplayMedicationIntakeResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/extract": {
    post: {
      tags: ["Medications"],
      summary: "Extract scheduling fields from a free-text medication description",
      description:
        "Runs the user's free-text description through the Coach provider chain and returns a citation-guarded partial payload the wizard merges onto whatever the user already typed. `name` and `dose` are dropped when not substring-matched in the original text so the wizard cannot land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped. Rate-limited 10 requests / 5 minutes / user, gated against the daily Coach token budget.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationExtractRequest },
        },
      },
      responses: {
        "200": {
          description: "Citation-guarded partial extraction.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationExtractionSchema,
                "MedicationExtractResponse",
              ),
            },
          },
        },
        "502": {
          description:
            "Upstream provider returned an empty, unparseable, or off-schema reply.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No AI provider configured for the calling user (or operator).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/cadence": {
    get: {
      tags: ["Medications"],
      summary: "Cadence + compliance read for a medication",
      description:
        "Returns the expected-vs-actual dose timeline for the requested window plus the four compliance chip values that drive the detail-page section. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone so a Tokyo user and a Berlin user see the same chips for the same medication. The `days` query parameter caps at 180.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          days: z
            .coerce
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe("Window size in days (default 30, max 180)."),
        }),
      },
      responses: {
        "200": {
          description: "Cadence response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationCadenceResponse,
                "GetMedicationCadenceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Adherence read for a medication",
      description:
        "Returns the 7- and 30-day adherence summaries, the per-day compliance grid for the history glyph track, and the two-row display block. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone, and the expected-dose denominator is cadence-aware (RRULE / rolling / one-shot / PRN / cyclic) and clamped to the medication's `createdAt`. Read `compliance30` for the headline 30-day taken-vs-expected percentage; build the per-day glyph track from `dailyCompliance` (draw a cell only where `due === true`).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Compliance response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceResponse,
                "GetMedicationComplianceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/coach-prefs": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach prompt-tuning preferences",
      description:
        "Returns the persisted preferences with defaults filled in. Null persisted state resolves to the legacy v1.4.22 defaults.",
      responses: {
        "200": {
          description: "Resolved preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "GetCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user Coach prompt-tuning preferences",
      description:
        "Persists the supplied prefs. Body is validated against `CoachPrefs`; missing keys fall back to the documented defaults.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: coachPrefsSchema } },
      },
      responses: {
        "200": {
          description: "Saved preferences echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPrefsSchema, "PutCoachPrefsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/disable-coach": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user Coach opt-out flag",
      description:
        "Returns the user's per-account Coach opt-out flag. Default `false` (Coach visible). Powers the Settings → Insights \"Hide Coach\" Switch and the layout FAB short-circuit.",
      responses: {
        "200": {
          description: "Resolved flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(disableCoachFlag, "GetDisableCoachResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Toggle per-user Coach opt-out flag",
      description:
        "Flips the per-account Coach opt-out flag. Idempotent — the DB write fires even when the value matches so the audit-log row mirrors the API call. Rate-limit 60/min per user.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disableCoachFlag } },
      },
      responses: {
        "200": {
          description:
            "Resolved next-state echoed back for optimistic-update consumers.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disableCoachFlag,
                "PatchDisableCoachResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/source-priority": {
    get: {
      tags: ["Auth"],
      summary: "Read per-user source priority",
      description:
        "Returns the per-metric-class source priority used by the analytics aggregator. Missing keys fall back to `DEFAULT_SOURCE_PRIORITY`. Null persisted state resolves to the documented defaults.",
      responses: {
        "200": {
          description: "Resolved priority.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "GetSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Auth"],
      summary: "Replace per-user source priority",
      description:
        "Persists the supplied priority. Body is validated against `SourcePriority`; missing keys read as `DEFAULT_SOURCE_PRIORITY` at the call site.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: sourcePrioritySchema } },
      },
      responses: {
        "200": {
          description: "Saved priority (defaulted) echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                sourcePrioritySchema,
                "PutSourcePriorityResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar": {
    post: {
      tags: ["Auth"],
      summary: "Upload the calling user's avatar",
      description:
        "Multipart upload (field `file`). Accepts image/jpeg, image/png, image/webp; rejects anything else at the magic-byte sniff (the multipart Content-Type header is informational only). Hard caps: 2 MiB body, 2048×2048 dimensions. Replaces the v1.4.22 Gravatar leak by storing the bytes on the User row + serving them from same-origin.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z
                .string()
                .describe(
                  "Binary image payload (JPEG / PNG / WebP). Hard-capped at 2 MiB and 2048×2048.",
                ),
            }),
          },
        },
      },
      responses: {
        "201": {
          description:
            "Avatar saved. `avatarUrl` is the same value the /me payload returns; the `?v=` suffix busts client caches on re-upload.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  avatarUrl: z.string(),
                  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
                  updatedAt: z.iso.datetime({ offset: true }),
                }),
                "UploadAvatarResponse",
              ),
            },
          },
        },
        "413": {
          description:
            "Upload exceeds the 2 MiB byte limit or the 2048×2048 dimension limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            "Image format is not one of JPEG / PNG / WebP (magic-byte sniff).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Clear the calling user's avatar",
      description:
        "Resets the avatar columns to null. Idempotent — a delete on an already-empty row returns 204 with no audit-log row.",
      responses: {
        "204": {
          description: "Avatar cleared (or already empty).",
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/avatar/{id}": {
    get: {
      tags: ["Auth"],
      summary: "Serve a user's avatar bytes",
      description:
        "Owner-scoped. The `{id}` path segment must match the calling user's id — cross-user reads return 403. Response body is the raw image bytes with the persisted `Content-Type`; the /me payload appends `?v={updatedAtMs}` so clients can cache aggressively.",
      requestParams: {
        path: z.object({
          id: z.string().describe("User id (must match the calling user)."),
        }),
      },
      responses: {
        "200": {
          description: "Avatar bytes.",
          content: {
            "image/jpeg": { schema: z.string().describe("Raw JPEG bytes.") },
            "image/png": { schema: z.string().describe("Raw PNG bytes.") },
            "image/webp": { schema: z.string().describe("Raw WebP bytes.") },
          },
        },
        "403": {
          description: "Caller is not the avatar's owner.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The user has no uploaded avatar.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/user/profile": {
    get: {
      tags: ["Auth"],
      summary: "Read the calling user's profile",
      description:
        "Flattened profile fields for the native client. Aliased over the same data exposed by /api/auth/me. The KVNR is decrypted server-side; the IKNR (v1.8.6) is returned plaintext.",
      responses: {
        "200": {
          description: "The calling user's profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(profileResponse, "GetProfileResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Auth"],
      summary: "Update the calling user's profile",
      description:
        "Partial profile update — every field is optional. An explicit null (or empty string) clears a field. A non-empty `insurerIkNumber` must be exactly 9 digits (422 otherwise); a non-empty `insuranceNumber` (KVNR) must pass the mod-10 check. `userId` is never accepted from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: profileUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Saved profile echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                profileUpdateResponse,
                "PatchProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/layout": {
    get: {
      tags: ["Insights"],
      summary: "Read the calling user's Insights tile layout",
      description:
        "Returns the per-user Insights tile layout (visibility + order). Falls back to the default layout when the user has not customised it. Mirrors the dashboard-widgets contract.",
      responses: {
        "200": {
          description: "The resolved layout (custom or default).",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayout"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Replace the calling user's Insights tile layout",
      description:
        "Persists the full tile layout. The normalised layout is returned. Invalid bodies return the multi-issue 422 envelope, matching the dashboard-widgets route.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsLayoutSchema },
        },
      },
      responses: {
        "200": {
          description: "Layout saved; the normalised layout is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutSchema, "InsightsLayoutSaved"),
            },
          },
        },
        // 422 (multi-issue validation envelope) comes from stdResponses.
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Reset the calling user's Insights tile layout",
      description:
        "Clears the persisted layout and returns the default layout. Idempotent.",
      responses: {
        "200": {
          description: "Layout reset; the default layout is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsLayoutSchema,
                "InsightsLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's durable Coach facts",
      description:
        "v1.11.1 — returns the active facts the Coach has extracted about the caller (highest-confidence then newest first), each decrypted on the fly. The GDPR 'what do you know about me' surface. Coach-gated (`requireAssistantSurface(\"coach\")`). Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.",
      responses: {
        "200": {
          description: "The caller's active facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachFactsListResponse, "CoachFactsList"),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Forget all of the caller's Coach facts",
      description:
        "v1.11.1 — bulk 'forget what you know about me': soft-deletes every active fact for the caller and returns the count cleared. Idempotent (a second call clears 0). Coach-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "All active facts cleared; the count is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactsClearedResponse,
                "CoachFactsCleared",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts/{id}": {
    delete: {
      tags: ["Insights"],
      summary: "Forget one Coach fact",
      description:
        "v1.11.1 — soft-deletes a single fact owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Coach-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description:
            "The fact was soft-deleted (`deleted: true`) or the id matched nothing the caller owns (`deleted: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactDeletedResponse,
                "CoachFactDeleted",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/messages/{id}/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate a Coach assistant message",
      description:
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity).",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachMessageFeedbackBody },
        },
      },
      responses: {
        "201": {
          description: "Feedback saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "CoachMessageFeedbackResponse",
              ),
            },
          },
        },
        "404": {
          description: "Message not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Caller has already rated this message text.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/notifications/diagnostic": {
    get: {
      tags: ["Admin"],
      summary: "Admin notification diagnostic snapshot",
      description:
        "Admin-only. Returns what the dispatcher would see when targeting the calling admin's account: registered devices (APNs tokens masked to prefix + suffix), per-channel enabled + configPresent flags, and recent push attempts (currently always `[]` pending the v1.4.48+ PushAttempt table). Cookie auth only — never Bearer.",
      responses: {
        "200": {
          description: "Diagnostic snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminDiagnosticData,
                "AdminDiagnosticResponse",
              ),
            },
          },
        },
        "403": {
          description: "Caller is not an admin.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/dashboard/snapshot": {
    get: {
      tags: ["Dashboard"],
      summary: "Unified dashboard first-paint snapshot",
      description:
        "Assembles every above-the-fold tile field in one round-trip from the rollup / mood / widget helpers plus a read-only lift of the pre-generated daily briefing. Two-phase: `tiles` always present, `extras` nullable on a rollup-coverage miss. No LLM is reachable from this path. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "Dashboard snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardSnapshotResponse,
                "DashboardSnapshotResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/comprehensive": {
    get: {
      tags: ["Insights"],
      summary: "Comprehensive AI insights bundle",
      description:
        "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations. Strict-schema validated server-side.",
      responses: {
        "200": {
          description: "Insights bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsComprehensiveResponse,
                "InsightsComprehensiveResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/pregenerate": {
    post: {
      tags: ["Insights"],
      summary: "Warm all AI assessments for the calling user",
      description:
        "v1.8.7.1 — enqueue a full warm of every AI assessment for the authenticated user (comprehensive insight + the seven specialised status cards + every data-bearing generic metric assessment) in the active locale, so the read-only status GETs serve cached text instantly. Returns immediately; the generation runs out of band on the worker. Empty metrics and provider-less accounts never trigger an LLM call. Short anti-spam bucket (`insights-warm:<userId>`, one warm per 3 minutes) → 429 on a tight loop. Auth via cookie or Bearer; `userId` is taken from the session, never the body.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: insightsPregenerateRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Warm accepted and enqueued. The work runs on the worker; poll the read-only status routes for the text.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsPregenerateResponse,
                "InsightsPregenerateResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/analytics/range": {
    get: {
      tags: ["Analytics"],
      summary: "Single-metric period-over-period range delta",
      description:
        "v1.9.0 — returns the current-window aggregate, the previous comparable window, and the composed delta for ONE metric type over a `7d` / `30d` / `90d` / `1y` range. Single-type by construction (the metric page is single-metric), so the read is one rollup-tier call covering the trailing 2N days sliced into the two halves — no per-type fan-out. Additive route; the `/api/analytics` envelope is unchanged. Auth via cookie or Bearer.",
      requestParams: {
        query: analyticsRangeQuery,
      },
      responses: {
        "200": {
          description: "Current + previous window aggregates and the delta.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                analyticsRangeResponse,
                "AnalyticsRangeResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/blood-pressure-status": {
    get: {
      tags: ["Insights"],
      summary: "Blood-pressure assessment",
      description:
        "Data-driven plain-language assessment of the user's recent blood-pressure readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BloodPressureStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/pulse-status": {
    get: {
      tags: ["Insights"],
      summary: "Pulse assessment",
      description:
        "Data-driven plain-language assessment of the user's recent resting-pulse readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "PulseStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/weight-status": {
    get: {
      tags: ["Insights"],
      summary: "Weight assessment",
      description:
        "Data-driven plain-language assessment of the user's recent weight trend. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "WeightStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/bmi-status": {
    get: {
      tags: ["Insights"],
      summary: "BMI assessment",
      description:
        "Data-driven plain-language assessment of the user's body-mass index. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BmiStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/mood-status": {
    get: {
      tags: ["Insights"],
      summary: "Mood assessment",
      description:
        "Data-driven plain-language assessment of the user's recent mood entries. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "MoodStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/medication-compliance-status": {
    get: {
      tags: ["Insights"],
      summary: "Medication-compliance assessment",
      description:
        "Data-driven plain-language assessment of the user's medication compliance — an overall `summary` plus a per-medication note array. Read-only: a cache miss warms a generation out of band and serves the last-good envelope meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        "200": {
          description:
            "Compliance assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceStatusResponse,
                "MedicationComplianceStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/metric-status": {
    get: {
      tags: ["Insights"],
      summary: "Generic per-HealthKit-metric assessment",
      description:
        "v1.8.7.1 — data-driven plain-language assessment for any registered HealthKit metric (resting heart rate, sleep, glucose, body composition, gait, audio exposure, …). One generic route covering ~30 metric pages via archetype prompt templates + per-metric metadata. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). An unknown `metric` 422s against the closed registry enum. Auth via cookie or Bearer.",
      requestParams: {
        query: metricStatusQuery,
      },
      responses: {
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                metricStatusResponse,
                "MetricStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metric (compute-once)",
      description:
        "v1.10.0 — the compute-once `Derived<T>` value for any registered derived wellness metric (personal typical-range vitals baseline, cardio-fitness band, vascular-age delta, sleep score, readiness, coincident-deviation flag). One generic route over a closed registry enum; an unknown `metric` 422s. Pure compute over the rollup tier with a per-type live fallback on a coverage miss — no LLM call, no narrative, no cache table. Returns the flat `Derived<T>` union so the native client can decode one stable shape and combine values across metrics. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedMetricQuery,
      },
      responses: {
        "200": {
          description: "The flat derived-metric value (ok or insufficient).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedMetricResponse,
                "DerivedMetricResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived/batch": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metrics (batched compute-once)",
      description:
        "v1.10.0 — resolve several derived wellness metrics in ONE request. The `metrics` CSV names the metrics (a `metric:type` token sub-targets a VITALS_BASELINE vital); the server fans out under a bounded limiter with the profile loaded once and returns a map keyed by the per-request token. Collapses the Insights cold-mount fan-out of 14+ independent single-metric requests — the pool-starvation class that surfaces as a hang-then-recover. The single-metric route stays for the per-score detail pages. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedBatchQuery,
      },
      responses: {
        "200": {
          description: "The map of derived-metric values, keyed by token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedBatchResponse,
                "DerivedBatchResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/correlations": {
    get: {
      tags: ["Insights"],
      summary: "Correlation discovery (FDR-controlled)",
      description:
        "v1.10.0 — scans a curated behaviour × outcome matrix (daylight / mood / glucose / BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour day to the next day's outcome, runs Pearson with the exact Student-t p-value, and applies Benjamini-Hochberg FDR control across every tested pair. Only statistically-defensible pairs surface, each carrying n, r, p, and the BH-adjusted q. Descriptive, never causal. Gated by the operator `correlations` assistant surface. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The discovered correlations + the tested-pair count.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                correlationDiscoveryResponse,
                "CorrelationDiscoveryResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

export const openApiComponents: NonNullable<ZodOpenApiObject["components"]> = {
  // Schemas listed here are forced into `components.schemas` even when no
  // route references them directly. `Medication` lives in this slot
  // because its only consumers are the `MedicationListEntry` /
  // `MedicationDetail` variants which extend it — `.extend()` inlines
  // the base shape into the derived schema, so without an explicit
  // registration the standalone `Medication` component would never
  // emit. The iOS codegen reads from `Medication` directly for the
  // shared Swift struct backing both variants.
  schemas: {
    Medication: medicationResource,
  },
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "hlk_<64hex>",
      description:
        "Native-client API token. Use the `token` field returned by /api/auth/login on a native client.",
    },
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "healthlog_session",
      description: "Browser session cookie — set by /api/auth/login.",
    },
  },
};
