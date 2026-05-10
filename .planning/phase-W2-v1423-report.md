# Wave 2 — v1.4.23 backend foundation report

Status: shipped on `develop` (2026-05-11).
Scope: F1 (`MeasurementType` extension), F2 (`MeasurementSource`
expansion), F3 (`POST /api/measurements/batch`) plus the
analytics-side sleep-stage aggregation the new schema unblocks.

## What landed

### Six atomic commits

1. **`feat(schema)` — Apple Health measurement types + sleep stages
   + dedup index.** `prisma/schema.prisma` gains seven additive
   `MeasurementType` values, `APPLE_HEALTH` joins `MeasurementSource`,
   a new `SleepStage` enum mirrors the existing `GlucoseContext`
   pattern, and `Measurement` picks up nullable `sleepStage` +
   `externalSourceVersion` columns plus a composite unique index
   `(user_id, type, source, external_id)`. Migration
   `0036_apple_health_measurement_types` is strictly additive — no
   row mutations.
2. **`feat(measurements)` — Apple Health identifier mapping helper.**
   New `src/lib/measurements/apple-health-mapping.ts` translates each
   HealthKit identifier into the row shape the `Measurement` model
   expects. Mirrors the Withings `MEASURE_TYPE_MAP` but keyed by
   string identifier. Unit conversion (0..1 fraction → percent for
   oxygen saturation and body fat) sits per-entry next to the type.
   16 unit tests, including the sleep-stage codepoint map.
3. **`feat(api)` — batch measurement ingest for iOS Apple Health.**
   `POST /api/measurements/batch` accepts ≤500 entries per call,
   wraps in `withIdempotency()` for HTTP-level retry safety, and
   relies on the composite unique index for per-entry dedup. Returns
   per-entry status (`inserted` / `duplicate` / `skipped`) so the
   iOS client can advance its sync cursor accurately. Six integration
   tests under `tests/integration/measurements-batch.test.ts`.
4. **`feat(ui)` — Apple Health source badge + restore-route enum
   sync.** Dracula-pink chip in the measurements list,
   `measurements.sourceAppleHealth` translation keys (EN + DE),
   admin backup-restore guard updated for the new enum values.
   Three regression-guard tests for the badge.
5. **`feat(analytics)` — per-stage sleep aggregation.**
   `/api/analytics` aggregates SLEEP_DURATION rows per Berlin day
   before summarising so multi-stage nights surface as one datapoint.
   New optional `sleepStages` block exposes the per-stage minute
   breakdown over the trailing 30 days. Two integration tests.
6. **`docs(planning)` — STATE.md tick + this report.**

### Test count delta

- Unit tests: 2111 → 2130 (+19; 16 mapping + 3 badge regression).
- Integration tests: 89 → 97 (+8; 6 batch ingest + 2 sleep stage).
- `pnpm typecheck`, `pnpm lint`, `pnpm test --run`, and
  `pnpm test:integration` are all green between every commit.

### Migration name + SQL summary

`prisma/migrations/0036_apple_health_measurement_types/migration.sql`.

- `ALTER TYPE measurement_type ADD VALUE IF NOT EXISTS …` × 7 (the
  seven new HealthKit-shaped values).
- `ALTER TYPE measurement_source ADD VALUE IF NOT EXISTS
  'APPLE_HEALTH'`.
- `CREATE TYPE sleep_stage AS ENUM (…)`.
- `ALTER TABLE measurements ADD COLUMN external_source_version
  TEXT, ADD COLUMN sleep_stage sleep_stage` (both nullable).
- CHECK constraint scoping `sleep_stage` to SLEEP_DURATION rows
  (mirrors the glucose_context constraint from migration 0021).
- `CREATE UNIQUE INDEX measurements_user_id_type_source_external_id_key
  ON measurements (user_id, type, source, external_id)` — Apple
  Health batch dedup key. Postgres treats NULL externalId rows as
  distinct, so manual entries don't collide.

The legacy `(user_id, type, measured_at, source)` unique index stays
in place as the manual-UI "no duplicate at the same wall-clock"
guard.

## W1 recommendations adopted verbatim

| W1 recommendation | Status |
|---|---|
| Source enum value = `APPLE_HEALTH` (not `HEALTHKIT`) | Adopted |
| Reuse existing `ACTIVITY_STEPS` for HK step count | Adopted |
| Reuse existing `SLEEP_DURATION`, shift unit hours → minutes | Adopted |
| Per-stage sleep rows with new `sleep_stage` column | Adopted |
| `apple-health-mapping.ts` keyed by HK string identifier | Adopted |
| Apple ships 0..1 fraction for SpO2 + body fat → × 100 | Adopted |
| `BODY_TEMPERATURE` enum value alongside the other 6 | Adopted |

## Decisions made beyond W1's scope

- **Per-entry status as `inserted | duplicate | skipped`** with a
  documented `reason` field for skips (`unmappable_identifier`,
  `value_out_of_range`). The iOS client checkpoints past `inserted`
  AND `duplicate` and surfaces `skipped` for diagnostics. W1 didn't
  pin the exact wire shape; I picked the names that read clearest in
  the iOS-client perspective.
- **Plausibility-range guard runs per-entry, never fails the batch.**
  A single bogus sensor reading becomes a `skipped` entry rather than
  crashing the whole upload. The validator inherits HealthLog's
  existing `validateMeasurementRange()` thresholds; new ranges were
  added for HRV (1–200 ms), resting HR (25–220 bpm), active energy
  (0–10 000 kcal), flights (0–1000), distance (0–200 km), VO2 max
  (5–100 mL/(kg·min)), body temperature (28–45 °C).
- **Skip-duplicates reconciliation when `createMany` races a concurrent
  retry.** The endpoint performs a pre-flight existence check, then
  uses `createMany({ skipDuplicates: true })`. If the count returned
  by `createMany` doesn't match the planned-insert count (a race),
  the endpoint re-reads the DB and downgrades the affected per-entry
  statuses from `inserted` to `duplicate` so the response stays
  truthful.
- **`sleepStages` block returns `null` when the user has no
  stage-tagged rows** rather than an empty object. The UI consumer
  can then keep painting the totals-only path verbatim.

## What I couldn't ship and why

Nothing in scope was dropped. Three adjacent items are explicitly
deferred per the brief:

- **APNs scaffolding (Wave 3 F4)** stays untouched here — the brief
  noted I should be aware of the `apnsEnvironment` decision but not
  implement it.
- **OpenAPI generator + Coach schema extension (Wave 4 F5/F6)** —
  outside this wave's scope. F6 wants the new metric tokens in the
  `sourceMetric` enum; `chart-tokens.ts` already accepts them so the
  AI surface can reference them, but the Coach prompt + provenance
  ratchet ships in W4.
- **Doctor PDF rendering for the new HealthKit metrics** —
  intentionally excluded for v1.4.23 (see
  `measurement-type-enum-coverage.test.ts`); ships in v1.5 alongside
  the iOS app's first paying-customer sync once layout + reference
  ranges are agreed.

## Open questions for the maintainer about the iOS DTO contract

1. **DTO rename `HEALTHKIT` → `APPLE_HEALTH`.** Server-side is now
   locked. The iOS repo (`~/Projects/healthlog-iOS/`) needs the
   `MeasurementDTO.swift` enum value rename in lock-step. The
   maintainer's encoded sim payloads should be cleared after the
   rename (one-line in the iOS dev README). Confirm the maintainer
   will land this in the same release window — once a TestFlight
   build ships, the rename becomes a breaking change.
2. **`externalId` shape.** Server treats it as an opaque string
   ≤120 chars. The iOS contract should pin `HKSample.uuid.uuidString`
   as the value, NOT a synthesised "type-id::date" composite —
   otherwise two iOS devices syncing the same Apple-Cloud sample
   would generate different `externalId`s and the dedup index can't
   collapse them.
3. **`sleepStage` codepoint domain.** Server accepts integers 0–20
   to leave headroom for Apple's future additions; the documented
   iOS-16+ codepoints are 0–5. If the iOS DTO ships an enum, confirm
   it serialises as the numeric codepoint rather than a string label
   so the server-side `APPLE_HEALTH_SLEEP_STAGE_MAP` does the
   translation.
4. **Pre-conversion vs post-conversion on the wire.** Server
   currently expects Apple's native units verbatim (0..1 fraction for
   SpO2 / body fat, kcal for active energy, etc.) and converts to DB
   units inside the mapping. Confirm the iOS app does NOT pre-convert
   on its side — otherwise we double-multiply and SpO2 lands at 9 700.
5. **Behaviour when iOS pushes a sample with a HealthKit identifier
   the server doesn't know yet** (e.g. a hypothetical new metric Apple
   adds in iOS 18). Today the server marks the entry as
   `skipped`/`unmappable_identifier`. Does the iOS app drop those
   samples from its sync cursor (one-shot retry on next server
   release with the new mapping), or does it park them for re-upload
   after the next app update? Recommendation: park-for-retry so a
   server-side mapping addition automatically backfills.

## Verification commands

```bash
pnpm typecheck      # green
pnpm lint           # green (only pre-existing warnings)
pnpm test --run     # 2130 passed (was 2111)
pnpm test:integration   # 97 passed (was 89)
```

Six commit SHAs on `develop` are visible via `git log
origin/develop..HEAD` once pushed (W2 sequence is `95209eb`, `30c0f76`,
`5cc0a00`, `86a80c5`, `5470649` + this docs commit).
