# Wave 1 — v1.4.23 research (Apple Health + APNs + OpenAPI)

Status: research-only. No source files modified. Outputs feed W2
(Apple Health foundation), W3 (APNs scaffolding), and W4
(OpenAPI gate + Coach schema slot + native auth).

Cross-references:

- `.planning/STATE.md` Wave 2-4 sub-items
- `prisma/schema.prisma` lines 189-245 (`MeasurementType`,
  `MeasurementSource`, `Measurement`)
- `src/lib/withings/client.ts` lines 122-133 (mapping pattern to
  mirror)
- `src/lib/notifications/dispatcher.ts` (cascade we extend)
- `src/lib/notifications/senders/web-push.ts` (sender shape to
  mirror, returns `SendOutcome`)
- `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Models/MeasurementDTO.swift`
  (already-shipped iOS DTO — names the source `HEALTHKIT`, not
  `APPLE_HEALTH`)
- `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Services/HealthKitService.swift`
  (already-wired `defaultReadTypes` set)

---

## Stream 1 — Apple Health mapping

### Naming-decision callout (read first)

The iOS app already ships an enum value `HEALTHKIT` for the
measurement-source field in
`MeasurementDTO.swift` (line 60):

```swift
case healthKit = "HEALTHKIT"
```

The marathon brief calls it `apple_health` / `APPLE_HEALTH`. Two
options:

1. **Server adopts `HEALTHKIT`** — matches the already-shipped
   iOS DTO, no client-side change. Cost: the source name leaks
   the framework name (HealthKit) rather than the brand
   (Apple Health) into our DB enum. Apple's own marketing surface
   says "Apple Health", but their developer surface says
   "HealthKit".
2. **Server adopts `APPLE_HEALTH`** — matches the marathon brief
   and Marc's user-facing voice ("Apple Health"). Cost: iOS DTO
   needs a one-line rename + compatibility shim for any encoded
   payloads already on disk in the iOS sim build.

**Recommendation: `APPLE_HEALTH`.** The DB enum is a stable
contract value, not a brand label, but it is also user-facing
through analytics/audit-log surfaces. "Apple Health" is the term
users recognise. The iOS DTO is still pre-TestFlight (no real
users on the encoded format yet) so the rename is essentially
free.

W2 should land the rename in `MeasurementDTO.swift` in the same
PR that lands the server enum so the contract stays in lock-step.

### Mapping table

Aggregation rule reads:

- `latest` — store every sample as-is, dedup by `(externalId)`
- `sum` — sum samples in a 1-hour rollup window (Apple's hourly
  observer-query batch grain)
- `mean` — arithmetic mean of values in the rollup window
- `last_per_window` — keep the chronologically latest value when
  multiple samples land in one upload batch (Apple's discrete-
  scalar pattern, e.g. resting HR)

| HK identifier              | DB MeasurementType               | DB unit     | HK unit                                               | Conversion              | Aggregation     | Privacy / consent                       | Notes                                                                                                                                       |
| -------------------------- | -------------------------------- | ----------- | ----------------------------------------------------- | ----------------------- | --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyMass`                 | `WEIGHT` (existing)              | kg          | `.gramUnit(.kilo)`                                    | identity                | latest          | already in scope                        | already shipped; no schema change                                                                                                           |
| `bloodPressureSystolic`    | `BLOOD_PRESSURE_SYS` (existing)  | mmHg        | `.millimeterOfMercury()`                              | identity                | latest          | already in scope                        | always paired with diastolic; iOS posts both as separate rows on identical `measuredAt` (matches Withings pattern)                          |
| `bloodPressureDiastolic`   | `BLOOD_PRESSURE_DIA` (existing)  | mmHg        | `.millimeterOfMercury()`                              | identity                | latest          | already in scope                        | see above                                                                                                                                   |
| `heartRate`                | `PULSE` (existing)               | bpm         | `.count()/.minute()`                                  | identity                | last_per_window | already in scope                        | spot pulse only; Apple Watch generates many per day — iOS must throttle (e.g. one sample every 5 min) before posting or the batch saturates |
| `heartRateVariabilitySDNN` | `HEART_RATE_VARIABILITY` (NEW)   | ms          | `.secondUnit(.milli)`                                 | identity                | mean            | yes (new — explicit consent screen)     | Apple captures during sleep window; one sample per night typical                                                                            |
| `restingHeartRate`         | `RESTING_HEART_RATE` (NEW)       | bpm         | `.count()/.minute()`                                  | identity                | last_per_window | already in scope (umbrella with PULSE)  | Apple emits one per day from sleep + low-activity windows                                                                                   |
| `stepCount`                | `STEP_COUNT` (NEW)               | steps       | `.count()`                                            | identity                | sum             | already in scope                        | cumulative; iOS posts daily totals at 23:55 local + a delta on observer wake                                                                |
| `activeEnergyBurned`       | `ACTIVE_ENERGY_BURNED` (NEW)     | kcal        | `.kilocalorie()`                                      | identity                | sum             | already in scope                        | cumulative; same daily-rollup pattern as steps                                                                                              |
| `flightsClimbed`           | `FLIGHTS_CLIMBED` (NEW)          | flights     | `.count()`                                            | identity                | sum             | already in scope                        | cumulative; same daily rollup                                                                                                               |
| `distanceWalkingRunning`   | `WALKING_RUNNING_DISTANCE` (NEW) | m           | `.meter()`                                            | identity                | sum             | already in scope                        | cumulative; SI metres in DB, UI converts to km/mi per locale                                                                                |
| `vo2Max`                   | `VO2_MAX` (NEW)                  | mL/(kg·min) | `.literUnit(.milli) / (.gramUnit(.kilo) · .minute())` | identity                | last_per_window | yes (new — fitness/health-grade metric) | one sample per few days at most                                                                                                             |
| `sleepAnalysis`            | `SLEEP_DURATION_DETAILED` (NEW)  | minutes     | category                                              | sum durations per stage | sum             | yes (new — explicit consent)            | NOT a quantity type; see "Sleep schema branch" below                                                                                        |

**Net new MeasurementType values: 8.**

`HEART_RATE_VARIABILITY`, `SLEEP_DURATION_DETAILED`,
`RESTING_HEART_RATE`, `STEP_COUNT`, `ACTIVE_ENERGY_BURNED`,
`FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `VO2_MAX`.

These mirror the values listed in `STATE.md` Wave 2 F1 verbatim
except for the rename `ACTIVITY_STEPS` (existing) →
`STEP_COUNT` (new). See "Naming collision" below.

### Naming collision: existing `ACTIVITY_STEPS` and `SLEEP_DURATION`

The current `MeasurementType` enum already contains
`ACTIVITY_STEPS` (steps unit) and `SLEEP_DURATION` (hours unit).
Neither has any production data path today — `getUnitForType`
returns `steps`/`hours` and the `validateMeasurementRange` row
exists, but no ingest route or UI surface wires either.

Two options:

1. **Reuse the existing `ACTIVITY_STEPS` and `SLEEP_DURATION`
   enum values** for Apple Health steps + sleep, and SKIP adding
   `STEP_COUNT` / `SLEEP_DURATION_DETAILED`. Net new = 6.
2. **Add the new `STEP_COUNT` / `SLEEP_DURATION_DETAILED` values
   and deprecate the originals** (no production data → safe).
   Net new = 8 (matches STATE.md).

**Recommendation: option 1, reuse `ACTIVITY_STEPS` and
`SLEEP_DURATION`.** The existing values were added in
anticipation of exactly this work (per the comment in
`schema.prisma` near lines 195-196). Adding parallel new values
fragments the enum and forces every analytics codepath to handle
two synonyms. The marathon brief's name `STEP_COUNT` is the
HealthKit identifier; our DB convention is the domain noun
(WEIGHT, PULSE, BODY_FAT) — so `ACTIVITY_STEPS` already fits the
house style better than `STEP_COUNT` does.

Sleep needs the unit changed from `hours` to `minutes` (HealthKit
emits sleep durations as minute-resolution category samples;
storing fractional hours loses precision). That's a Wave 2 F1
sub-decision — schema-only since no data exists.

**Net new with option 1 adopted: 6.** Final list:
`HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`,
`ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
`WALKING_RUNNING_DISTANCE`, `VO2_MAX`.

### Sleep schema branch (the one that's not a `HKQuantityType`)

`HKCategoryTypeIdentifier.sleepAnalysis` is a category type, not
a quantity type. Each sample has a value drawn from
`HKCategoryValueSleepAnalysis`:

- `inBed`
- `asleepUnspecified` (legacy iOS 15-)
- `awake`
- `asleepCore` (iOS 16+)
- `asleepDeep` (iOS 16+)
- `asleepREM` (iOS 16+)

Each sample has a `startDate` and `endDate`; duration is
`endDate - startDate` in seconds. A single night produces tens of
samples (every stage transition).

Two server-shape options:

1. **Single `Measurement` row per night with summed total** —
   value = total minutes asleep, no stage breakdown. Easiest;
   loses Apple's stage data the user paid Watch battery for.
2. **One `Measurement` row per stage per night** — value =
   minutes in that stage, with a new `sleepStage` enum column.
   Symmetrical to the existing `glucoseContext` column.

**Recommendation: option 2 with a new `sleepStage` enum column
on `Measurement`** (`CORE`, `DEEP`, `REM`, `AWAKE`, `IN_BED`).
NULL for non-sleep measurements, mirroring the existing
`glucoseContext` pattern. The Coach extension (W4 F6) will want
the stage breakdown to honour the "no clinical sleep-stage
conclusions" rule from the v1.5 product-lead memo — without the
stage rows we can't audit prompt compliance.

Migration: `ALTER TABLE measurements ADD COLUMN sleep_stage
sleep_stage NULL`. Add a CHECK constraint mirroring the
`glucoseContext` pattern: `sleep_stage` non-NULL only when
`type = SLEEP_DURATION`.

### `apple-health-mapping.ts` skeleton

Path: `src/lib/measurements/apple-health-mapping.ts` (new dir,
new file — symmetrical to the implicit Withings mapping in
`src/lib/withings/client.ts:122-133`).

```ts
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Apple HealthKit identifier → HealthLog `MeasurementType` mapping.
 * Mirrors the Withings `MEASURE_TYPE_MAP` in src/lib/withings/client.ts
 * but keyed by string identifier (Apple's own constant name) rather
 * than a numeric type code.
 *
 * Values:
 *   - `type`     — DB enum
 *   - `unit`     — canonical DB unit (must match unitMap in
 *                  src/lib/validations/measurement.ts)
 *   - `aggregate`— how the ingest endpoint should reduce a batch of
 *                  HK samples into stored Measurement rows
 *   - `consent`  — UI must show explicit consent before requesting
 *                  HKObjectType permission for these
 */
export type HealthKitAggregation =
  | "latest"
  | "sum"
  | "mean"
  | "last_per_window";

export interface AppleHealthMapping {
  type: MeasurementType;
  unit: string;
  aggregate: HealthKitAggregation;
  consent: "implicit" | "explicit";
  /**
   * Number of HK sample-fractional-units per 1 DB-unit. 1.0 = identity.
   * `heartRateVariabilitySDNN` ships as `secondUnit(.milli)` on Apple's
   * side and we store `ms` — identity. `oxygenSaturation` ships as a
   * 0..1 fraction and we store percent (0..100) — `factor: 100`.
   */
  factor: number;
}

export const APPLE_HEALTH_TYPE_MAP: Record<string, AppleHealthMapping> = {
  // Body composition
  HKQuantityTypeIdentifierBodyMass: {
    type: "WEIGHT",
    unit: "kg",
    aggregate: "latest",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierBodyFatPercentage: {
    type: "BODY_FAT",
    unit: "%",
    aggregate: "latest",
    consent: "implicit",
    factor: 100, // Apple ships 0..1 fraction
  },

  // Cardiovascular
  HKQuantityTypeIdentifierBloodPressureSystolic: {
    type: "BLOOD_PRESSURE_SYS",
    unit: "mmHg",
    aggregate: "latest",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierBloodPressureDiastolic: {
    type: "BLOOD_PRESSURE_DIA",
    unit: "mmHg",
    aggregate: "latest",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierHeartRate: {
    type: "PULSE",
    unit: "bpm",
    aggregate: "last_per_window",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierRestingHeartRate: {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    aggregate: "last_per_window",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    type: "HEART_RATE_VARIABILITY",
    unit: "ms",
    aggregate: "mean",
    consent: "explicit",
    factor: 1,
  },

  // Activity (cumulative)
  HKQuantityTypeIdentifierStepCount: {
    type: "ACTIVITY_STEPS", // reuses existing enum value (see report)
    unit: "steps",
    aggregate: "sum",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierActiveEnergyBurned: {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    aggregate: "sum",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierFlightsClimbed: {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    aggregate: "sum",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierDistanceWalkingRunning: {
    type: "WALKING_RUNNING_DISTANCE",
    unit: "m",
    aggregate: "sum",
    consent: "implicit",
    factor: 1,
  },

  // Fitness
  HKQuantityTypeIdentifierVO2Max: {
    type: "VO2_MAX",
    unit: "mL/(kg·min)",
    aggregate: "last_per_window",
    consent: "explicit",
    factor: 1,
  },

  // Other in-scope (already mapped via existing enums)
  HKQuantityTypeIdentifierBloodGlucose: {
    type: "BLOOD_GLUCOSE",
    unit: "mg/dL",
    aggregate: "latest",
    consent: "implicit",
    factor: 1,
  },
  HKQuantityTypeIdentifierOxygenSaturation: {
    type: "OXYGEN_SATURATION",
    unit: "%",
    aggregate: "last_per_window",
    consent: "implicit",
    factor: 100, // Apple ships 0..1 fraction; matches schema.prisma comment
  },
};

/**
 * sleepAnalysis is a category type, not a quantity type — it gets its
 * own table-shape branch. Keys here are the values of
 * `HKCategoryValueSleepAnalysis`. The ingest endpoint stores one
 * Measurement row per (night, stage), value = minutes-in-stage.
 */
export const APPLE_HEALTH_SLEEP_STAGE_MAP: Record<
  string,
  "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED"
> = {
  HKCategoryValueSleepAnalysisAsleepCore: "CORE",
  HKCategoryValueSleepAnalysisAsleepDeep: "DEEP",
  HKCategoryValueSleepAnalysisAsleepREM: "REM",
  HKCategoryValueSleepAnalysisAwake: "AWAKE",
  HKCategoryValueSleepAnalysisInBed: "IN_BED",
  // legacy iOS 15- — count as CORE for back-compat
  HKCategoryValueSleepAnalysisAsleepUnspecified: "CORE",
};
```

W2's F1+F2+F3 implementer fills in the migration + the
`POST /api/measurements/batch` route. The route's per-entry
validator just looks up `APPLE_HEALTH_TYPE_MAP[entry.hkIdentifier]`,
applies the `factor`, and inserts with `source = APPLE_HEALTH` +
`externalId = entry.uuid` (HealthKit's `HKSample.uuid` is stable
across queries — it's the dedup key).

### Open questions for the maintainer

1. **`HEALTHKIT` vs `APPLE_HEALTH` source enum value.** This
   research recommends `APPLE_HEALTH` and renaming the iOS DTO
   in the same PR. Confirm or override before W2 starts.
2. **Reuse `ACTIVITY_STEPS` + `SLEEP_DURATION` (option 1 above)
   or add `STEP_COUNT` + `SLEEP_DURATION_DETAILED` as parallel
   values?** Recommendation: reuse, change SLEEP unit to minutes.
3. **Sleep stage breakdown — single row per night vs per-stage
   row with new `sleep_stage` column?** Recommendation:
   per-stage, mirrors the `glucoseContext` pattern.

---

## Stream 2 — APNs library decision

### Comparison

| axis                   | `@parse/node-apn`                                              | `apns2` (AndrewBarba)                                | hand-rolled `node:http2`      |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| last release           | 8.1.0, April 2026 (active)                                     | 12.2.0, May 2025 (12 months ago, but stable surface) | n/a                           |
| weekly downloads       | ~107k                                                          | ~6k                                                  | n/a                           |
| GitHub stars           | ~219                                                           | ~173                                                 | n/a                           |
| TypeScript types       | built-in `index.d.ts`                                          | 100% TypeScript codebase, types are the source       | hand-rolled                   |
| ESM support            | hybrid CJS/ESM                                                 | ESM + CJS (v12)                                      | native                        |
| HTTP/2 implementation  | native `http2`, connection pool                                | native `http2`, connection pool                      | manual                        |
| JWT signing            | bundled                                                        | bundled                                              | manual (jsonwebtoken or jose) |
| Sandbox vs prod toggle | `production: boolean` flag                                     | `host` string override                               | manual base URL               |
| Dependencies           | `debug`, `verror`, `node-forge`, `jsonwebtoken`                | only `jsonwebtoken` (small graph)                    | none                          |
| License                | MIT                                                            | MIT                                                  | n/a                           |
| Maintainer             | Parse Platform org (multi-maintainer, Parse Server downstream) | one maintainer                                       | n/a                           |
| Test mockability       | Stub the `Provider`; existing examples in Parse Server tests   | Stub `ApnsClient` interface                          | trivial — mock fetch shape    |

### Recommendation: **`@parse/node-apn`**

The active 8.1.0 release in April 2026 plus the 100k+
weekly-download install base under Parse Server is the dominant
signal. `apns2` is technically cleaner (single small dep, native
TypeScript codebase) but its maintenance pulse went quiet 12
months ago and the maintainer count is one. APNs's spec is
stable enough that "12 months quiet" is not a red flag on its
own, but if Apple introduces a new push type (precedent: the
`live-activity` type in iOS 16) we want a library whose issues
get triaged.

The downside is a slightly heavier dep graph (`node-forge`,
`verror`) but those are dependencies HealthLog's existing
notification stack already pulls transitively (`web-push` pulls
`node-forge` for VAPID JWT). Net new install footprint is small.

For tests, `dispatcher.test.ts`'s pattern of stubbing
sender modules at import time (see how `web-push` is treated)
applies cleanly: a test-only `mock-apns.ts` exporting the same
`sendViaApns(config, payload): SendOutcome` shape sidesteps the
library entirely. We **do not** need to mock the Parse provider
class — we only ever call our own wrapper.

Hand-rolled HTTP/2 is rejected: even though the protocol is
~150 lines, the JWT-key rotation logic (regenerate every 50 min,
share across requests, handle 403 InvalidProviderToken by
forcing immediate rotation) is exactly the kind of code that
sits unmaintained for years until Apple shifts a corner-case
status code. Outsourcing is correct here.

### Code sketch + env-var contract

Path: `src/lib/notifications/senders/apns.ts` (new).

```ts
import apn from "@parse/node-apn";
import { decrypt } from "@/lib/crypto";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

interface ApnsEnv {
  keyId: string;
  teamId: string;
  bundleId: string;
  signingKey: string; // .p8 PEM contents (multiline)
  production: boolean;
}

function loadEnv(): ApnsEnv | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  // APNS_KEY_FILE = path to .p8 (preferred for dev). APNS_KEY = inline
  // contents (preferred for Coolify env-block). One must be set.
  const signingKey =
    process.env.APNS_KEY ??
    (process.env.APNS_KEY_FILE
      ? require("node:fs").readFileSync(process.env.APNS_KEY_FILE, "utf8")
      : undefined);
  if (!keyId || !teamId || !bundleId || !signingKey) return null;
  const production = process.env.APNS_PRODUCTION === "true";
  return { keyId, teamId, bundleId, signingKey, production };
}

let cachedProvider: apn.Provider | null = null;

function getProvider(env: ApnsEnv): apn.Provider {
  // node-apn re-uses HTTP/2 connections + JWT internally; one Provider
  // per process is the documented pattern.
  if (cachedProvider) return cachedProvider;
  cachedProvider = new apn.Provider({
    token: { key: env.signingKey, keyId: env.keyId, teamId: env.teamId },
    production: env.production,
  });
  return cachedProvider;
}

/**
 * Send an APNs alert push to all registered devices for `userId`.
 * Mirrors the SendOutcome contract used by web-push so the dispatcher
 * can apply the same retry/cooldown logic uniformly.
 */
export async function sendViaApns(
  userId: string,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const env = loadEnv();
  if (!env) {
    return { ok: false, hardReject: false, reason: "apns_not_configured" };
  }

  const devices = await prisma.device.findMany({
    where: { userId, platform: "ios" },
  });
  if (devices.length === 0) {
    return { ok: false, hardReject: false, reason: "apns_no_devices" };
  }

  const provider = getProvider(env);
  const note = new apn.Notification();
  note.topic = env.bundleId;
  note.alert = { title: payload.title, body: payload.message };
  note.sound = "default";
  note.payload = { eventType: payload.eventType, ...payload.metadata };

  const start = performance.now();
  const tokens = devices.map((d) => d.token);
  const result = await provider.send(note, tokens);

  getEvent()?.addExternalCall({
    service: "apns",
    method: "send",
    duration_ms: Math.round(performance.now() - start),
    status: 200,
    error: result.failed.length === devices.length ? "all_failed" : undefined,
  });

  // 410 BadDeviceToken / 400 BadDeviceToken / "Unregistered" → drop the
  // device row (pattern mirrors web-push 410 cleanup)
  const dead = result.failed
    .filter(
      (f) =>
        f.response?.reason === "Unregistered" ||
        f.response?.reason === "BadDeviceToken",
    )
    .map((f) => f.device);
  if (dead.length > 0) {
    await prisma.device.deleteMany({ where: { token: { in: dead } } });
  }

  if (result.sent.length > 0) return { ok: true };

  // All failed and all permanent → hard reject. Else transient.
  if (dead.length === devices.length) {
    return {
      ok: false,
      hardReject: true,
      statusCode: 410,
      reason: "apns_all_devices_unregistered",
    };
  }
  const lastStatus = result.failed[0]?.status
    ? Number(result.failed[0].status)
    : undefined;
  const classified = classifyHttpStatus(lastStatus, "apns");
  return {
    ok: false,
    hardReject: false,
    statusCode: lastStatus,
    reason: classified.reason,
  };
}
```

**Env-var contract:**

| var               | required | shape                                            | notes                        |
| ----------------- | -------- | ------------------------------------------------ | ---------------------------- |
| `APNS_KEY_ID`     | yes      | 10-char alphanumeric                             | from Apple developer account |
| `APNS_TEAM_ID`    | yes      | 10-char alphanumeric                             | from Apple developer account |
| `APNS_BUNDLE_ID`  | yes      | reverse-DNS string (e.g. `dev.healthlog.ios`)    | `note.topic`                 |
| `APNS_KEY`        | one-of   | multiline PEM (`-----BEGIN PRIVATE KEY-----...`) | preferred for Coolify        |
| `APNS_KEY_FILE`   | one-of   | absolute path                                    | preferred for local dev      |
| `APNS_PRODUCTION` | optional | `"true"` or unset                                | default = sandbox            |

The `.p8` PEM contents are sensitive — encrypt at rest if we
ever start storing per-tenant keys. For v1.4.23 single-tenant
the env-var route is correct.

### `apns_attempts` table — reuse, don't add

The existing `NotificationChannel` model carries
`consecutiveFailures`, `nextRetryAt`, `lastFailureReason`,
`lastSuccessAt`, `disabledReason` — that's exactly the per-
channel retry state we need. APNs joins `TELEGRAM`, `NTFY`,
`WEB_PUSH` as a fourth `ChannelType` value.

**No new attempts table.** Reuse the channel-state machine in
`src/lib/notifications/channel-state.ts`. The Wave 3 tasks are:

1. Add `"APNS"` to `CHANNEL_TYPES` in
   `src/lib/notifications/types.ts`.
2. Switch case in `dispatcher.ts:sendToChannel()` calls
   `sendViaApns(payload.userId, payload)` (mirror the
   `WEB_PUSH` branch — also takes `userId` not `config`,
   because device tokens live in `Device` not in
   `NotificationChannel.config`).
3. The `NotificationChannel` row for an APNs user carries an
   empty config (like `WebPushChannelConfig`); the row exists
   so the per-event preference toggles in
   `NotificationPreference` work uniformly across all channels.

### Open questions for the maintainer

1. **Push type**: `alert` only for v1.4.23, or also `background`
   silent pushes (for HealthKit observer-query "wake the iOS app"
   pattern)? Background pushes need
   `apns-push-type: background` header + priority 5; Apple
   throttles them aggressively. Recommendation: `alert`-only
   for v1.4.23, defer background to v1.5 P4.
2. **Per-device opt-out**: today's `NotificationPreference` is
   per `(channel, eventType)`. With multiple iOS devices on one
   account, do we need per-device-token opt-out (mute APNs on
   one phone but not the other)? Punt to v1.5 P4 unless Marc
   says otherwise.
3. **Sandbox auto-detect**: the iOS app builds with two schemes
   (Debug → sandbox APNs gateway, Release → production). The
   server can't tell which gateway a device-token came from
   except by trial-and-error. Two options: (a) the iOS app
   includes `apnsEnvironment: "sandbox"|"production"` in
   `POST /api/devices`, (b) the server tries production first
   and falls back to sandbox on `BadDeviceToken`. Recommendation:
   (a) — explicit. Add `apnsEnvironment` column to `Device`
   model in W3.

---

## Stream 3 — OpenAPI tooling decision

### Comparison

| axis                             | `@asteasolutions/zod-to-openapi`                     | `zod-openapi` (samchungy)                                         | `ts-rest` / `next-rest`                  | hand-rolled  |
| -------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- | ------------ |
| weekly downloads                 | ~1.5M                                                | ~250k                                                             | ~50k each                                | n/a          |
| GitHub stars                     | ~1.5k                                                | ~640                                                              | ~5k / ~200                               | n/a          |
| Zod v4 support                   | yes (registry pattern unchanged)                     | yes (uses `.meta()` — Zod v4 native)                              | yes                                      | n/a          |
| OpenAPI 3.1 emit                 | yes                                                  | yes (last release Jan 2026 = active)                              | partial                                  | n/a          |
| Schema annotation style          | `.openapi({...})` (registers extension)              | `.meta({...})` (zod-native)                                       | route-binding DSL                        | json by hand |
| Setup cost                       | extend Zod once at boot, register schemas/routes     | import once, call `.meta()` per schema                            | rewrite all route handlers               | high         |
| Retrofit cost on existing routes | low — schemas already exist, register in a side file | low — annotate schemas in place, add a side file with route table | **high** — every route handler rewritten | high         |
| Coupling to Zod internals        | medium (custom `.openapi()` method)                  | low (uses Zod v4's standard `.meta()`)                            | high (own DSL)                           | none         |
| Active maintenance pulse         | active                                               | active (v5.4.6 January 2026)                                      | active                                   | n/a          |

### Recommendation: **`zod-openapi` (samchungy)**

Two reasons:

1. **Uses Zod v4's native `.meta()` method.** HealthLog already
   imports from `zod/v4` (per CLAUDE.md). `zod-openapi` reads
   the metadata that's already a first-class Zod v4 concept —
   no monkey-patching, no module-augmentation, no boot-time
   `extendZodWithOpenApi()` call. If Zod ever changes its
   metadata internals, the breakage surface is one library
   maintainer away from a fix; with `zod-to-openapi` it's two.
2. **Lighter retrofit footprint.** HealthLog has ~80+ routes
   under `src/app/api/`. Each has either an inline Zod schema
   or imports from `src/lib/validations/*`. With `zod-openapi`,
   we annotate the existing exported schemas in their original
   files (`createMeasurementSchema.meta({...})`) and wire a
   small `src/lib/openapi/registry.ts` that imports them and
   composes the `paths` object. With `zod-to-openapi`, every
   schema needs a `.openapi()` call AND a `registry.register()`
   AND a `registry.registerPath()` — ~3x the touchpoints.

`@asteasolutions/zod-to-openapi` is the safer-by-popularity
choice (10x the downloads) but the popularity is mostly Hono /
Express / NestJS users where it's the only option. For Next.js
App Router with Zod v4 already in the stack, `zod-openapi`'s
`.meta()` story is the better fit and keeps the spec generation
out of the route-handler hot path.

`ts-rest` / `next-rest` are rejected: both want to own the
route-handler shape (their `defineRoute()` wraps the handler).
Retrofitting 80+ existing `apiHandler()`-wrapped routes is a
multi-week refactor and would absorb the same surface area
v1.4.23 is supposed to be locking down, not churning.

### Implementation sketch

Three files, ~120 LOC total.

**`src/lib/openapi/registry.ts`** (new) — composes the spec
from already-exported Zod schemas:

```ts
import * as z from "zod/v4";
import { createDocument } from "zod-openapi";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  measurementTypeEnum,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { errorEnvelopeSchema, dataEnvelopeSchema } from "@/lib/api-response";
// ... import every schema we want in the spec

export function buildOpenApiSpec() {
  // Annotate schemas where they're not annotated in-place (fallback
  // path; preferred is to call .meta() in the validations file).
  measurementTypeEnum.meta({ id: "MeasurementType" });
  measurementSourceEnum.meta({ id: "MeasurementSource" });

  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "HealthLog API",
      version: process.env.npm_package_version ?? "1.4.23",
    },
    servers: [{ url: "https://healthlog.bombeck.io" }],
    paths: {
      "/api/measurements": {
        get: {
          /* ...listMeasurementsSchema as query params... */
        },
        post: {
          requestParams: {
            header: z.object({
              "Idempotency-Key": z.string().optional(),
            }),
          },
          requestBody: {
            content: {
              "application/json": { schema: createMeasurementSchema },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: dataEnvelopeSchema(
                    z.object({
                      id: z.string(),
                    }),
                  ),
                },
              },
            },
          },
        },
      },
      "/api/measurements/batch": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: createBatchMeasurementSchema },
            },
          },
          responses: {
            "200": {
              /* ... */
            },
          },
        },
      },
      // ... one per route
    },
  });
}
```

**`scripts/openapi-generate.ts`** (new):

```ts
#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import * as YAML from "yaml";
import { buildOpenApiSpec } from "@/lib/openapi/registry";

const spec = buildOpenApiSpec();
const yaml = YAML.stringify(spec);
writeFileSync("docs/api/openapi.yaml", yaml, "utf8");
console.log(`wrote docs/api/openapi.yaml (${yaml.length} bytes)`);
```

**`scripts/openapi-check.ts`** (new) — CI gate:

```ts
#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as YAML from "yaml";
import { buildOpenApiSpec } from "@/lib/openapi/registry";

const generated = YAML.stringify(buildOpenApiSpec());
const onDisk = readFileSync("docs/api/openapi.yaml", "utf8");

if (generated.trim() !== onDisk.trim()) {
  console.error(
    "OpenAPI spec drift detected. Run `pnpm openapi:generate` and commit.",
  );
  // Helpful diff for the PR reviewer
  execSync('diff <(echo "$GEN") docs/api/openapi.yaml || true', {
    env: { ...process.env, GEN: generated },
    stdio: "inherit",
    shell: "/bin/bash",
  });
  process.exit(1);
}
console.log("OpenAPI spec in sync with source schemas.");
```

**`package.json` scripts:**

```json
{
  "openapi:generate": "tsx scripts/openapi-generate.ts",
  "openapi:check": "tsx scripts/openapi-check.ts"
}
```

**CI gate:** add a step to the existing GH Actions PR workflow:

```yaml
- name: OpenAPI spec sync check
  run: pnpm openapi:check
```

The check is structural-equality on YAML text. For a more
robust diff we can swap to `oasdiff` (Go binary, GitHub Action
ready, generates a markdown breaking-change report) — but
sequence-equality is the cheaper W4 starting point and we can
upgrade to oasdiff in v1.4.24 without changing the generator
side.

### Migration approach for the existing 5468-line hand-maintained spec

The committed `docs/api/openapi.yaml` is large (80+ paths, 100+
schemas). Two-stage transition:

1. **W4 ships the generator covering the 6-8 routes the iOS app
   touches** (auth/login, auth/refresh, auth/me, measurements
   GET/POST, measurements/batch POST, devices POST, achievements
   GET). The CI check runs in **warn-only mode** (`continue-on-
error: true`) until coverage is complete.
2. **v1.4.24+ migrates the rest of the spec** route by route as
   they're touched by future PRs (organic adoption). Once
   coverage hits ~95%, flip `openapi:check` to fail-the-PR.

This avoids the "rewrite the whole spec in one PR" anti-pattern.
The committed YAML stays the source-of-truth-for-iOS during the
transition; the generator's output is a strict subset of it.

### Open questions for the maintainer

1. **Subset start vs full migration?** Recommendation: subset
   (the 6-8 iOS-touched routes), warn-only CI for v1.4.23, full
   coverage organically.
2. **YAML normalisation**: zod-openapi emits stable key order
   per its docs but YAML `.stringify` may reorder map keys
   between Node versions. Pin `yaml@2.x` and add a normalisation
   pass before equality compare? Recommendation: yes — use
   `yaml.stringify(spec, { sortMapEntries: true })` for both
   sides.
3. **`oasdiff` adoption**: defer to v1.4.24, or ship now? Cost
   of shipping now is one extra GH Action download + one binary
   on the runner; benefit is structured breaking-change
   detection on PR comments. Recommendation: defer — text-diff
   covers the W2/W3 contract-locking goal.

---

## Cross-stream notes

### iOS DTO already encodes some Wave 2 decisions

`MeasurementDTO.swift` includes a `BODY_TEMPERATURE` enum value
that does NOT exist in the server's `MeasurementType` enum
today. Either:

- iOS will skip body-temperature ingest for v1.4.23 (filter on
  the client), OR
- W2 adds `BODY_TEMPERATURE` as a 7th new value (HealthKit type
  `HKQuantityTypeIdentifierBodyTemperature`, unit `degC`).

Recommendation: **add `BODY_TEMPERATURE` in W2 alongside the
other 6 new types.** Cheap to ship a no-op enum value now versus
breaking the iOS DTO contract later.

Net new MeasurementType count if both options accepted:
**7** (`HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`,
`ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
`WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `BODY_TEMPERATURE`).

### Coach schema slot (W4 F6) preview

`src/lib/ai/schema.ts:260` defines:

```ts
sourceMetric: z.enum(["bp", "weight", "pulse", "mood", "compliance"]);
```

W4 extends to:

```ts
sourceMetric: z.enum([
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  // v1.4.23 additive (forward-compat for v1.5 iOS)
  "hrv",
  "sleep",
  "restingHr",
  "steps",
  "activeEnergy",
]);
```

`src/lib/ai/coach/types.ts:132` defines `CoachProvenance.metrics`
with the same value set — extend in lock-step. Both are additive,
no migration on `coach_messages.metricSourceJson` (TEXT column,
opaque to Postgres).

PROMPT_VERSION ratchet 4.22.0 → 4.23.0 (additive forward-compat,
matches the project_v1423_pre_ios_prep.md scope point 6).

### Top 3 sequencing risks for W2/W3/W4

1. **W2 + W4 F6 share files** (`src/lib/ai/schema.ts`,
   `src/lib/ai/coach/types.ts`). Land W2 first, F6 second, no
   parallel edit.
2. **The iOS DTO rename `HEALTHKIT` → `APPLE_HEALTH`** is a
   contract-break for the iOS app's encoded payloads on disk.
   Clear the iOS sim data store after the rename (one-line in
   the iOS dev README).
3. **W4 OpenAPI generator imports schemas from W2**. Land W2
   before W4 starts the generator file, OR have W4 use
   `as const` placeholders for the W2-introduced enum values
   that get filled in once W2 lands.
