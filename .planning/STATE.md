# v1.4.23 marathon — state log

Status: Wave 2 shipped (backend foundation)
Last update: 2026-05-11T00:25+02:00

> Previous milestone: v1.4.22 live (image digest
> `sha256:865154614303…`, `/api/version=1.4.22`).
> v1.4.23 = pre-iOS prep + hygiene. Backend foundation so the iOS
> Health app can ship in v1.5 without contract churn, plus 7
> hygiene items from `.planning/v1422-backlog.md`.

## Wave 1 — Research (single agent, three streams)

- [ ] Apple Health `HKQuantityTypeIdentifier` → `MeasurementType`
      mapping, with units + canonical aggregation rules
- [ ] APNs Node library decision (`apn` vs `@parse/node-apn` vs
      raw HTTP/2) with maintenance / type-safety / footprint pros/cons
- [ ] OpenAPI 3.1 generator tooling for Next.js routes
      (`@asteasolutions/zod-to-openapi`, `ts-rest`, `next-rest`,
      hand-rolled)
- Detailed report: `.planning/phase-W1-v1423-research.md`

## Wave 2 — Apple Health foundation (F1+F2+F3)

### F1 — `MeasurementType` enum extension

- [x] Added `HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`,
      `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
      `WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `BODY_TEMPERATURE`
      (W1 recommended reusing `ACTIVITY_STEPS` + `SLEEP_DURATION`
      verbatim; the iOS DTO already shipped `BODY_TEMPERATURE` so
      that joined the additive set — net new = 7)
- [x] Prisma migration `0036_apple_health_measurement_types`
- [x] Sleep unit shifted from hours to minutes; new `SleepStage`
      enum + nullable `Measurement.sleepStage` column (CHECK
      constraint scopes it to SLEEP_DURATION rows)
- [x] Composite unique index `(user_id, type, source, external_id)`
      — Apple Health batch dedup key
- [x] Unit conversions in
      `src/lib/measurements/apple-health-mapping.ts` (16 unit tests)

### F2 — `MeasurementSource` enum expansion

- [x] `APPLE_HEALTH` appended to the enum
- [x] UI badge in measurement-list (Dracula-pink chip) + bilingual
      `measurements.sourceAppleHealth` keys + admin restore-route
      enum guard sync

### F3 — `POST /api/measurements/batch`

- [x] New route at `src/app/api/measurements/batch/route.ts`,
      idempotent via `Idempotency-Key`
- [x] Validates batch ≤ 500 entries (returns 422
      `coach.batch.too_large`)
- [x] Dedupes via `(userId, type, source, externalId)` composite
- [x] Returns per-entry status (`inserted` / `duplicate` /
      `skipped`) + idempotency-replay-safe
- [x] Integration test (`tests/integration/measurements-batch.test.ts`,
      6 cases including idempotency replay)
- [x] Sleep-stage aggregation in `/api/analytics`:
      per-Berlin-day summary + `sleepStages` block
      (`tests/integration/analytics-sleep-stages.test.ts`)
- Detailed report: `.planning/phase-W2-v1423-report.md`

## Wave 3 — APNs scaffolding (F4)

- [x] Library install + lock-file (`@parse/node-apn@8.1.0`,
      W1 stream-2 decision)
- [x] `src/lib/notifications/senders/apns.ts` — `sendApnsPush()`
      one-shot helper plus `sendViaApns(userId, payload)` dispatcher
      entry mirroring the web-push contract
- [x] Env-var contract: `APNS_KEY_ID`, `APNS_TEAM_ID`,
      `APNS_BUNDLE_ID`, one of `APNS_KEY` / `APNS_KEY_FILE`,
      optional `APNS_PRODUCTION` — documented in `.env.example`,
      all-or-none guard with one-shot warning when partially set
- [x] `Device` Prisma model extension via migration
      `0037_apns_device_columns`: nullable `apnsToken` +
      `apnsEnvironment`, paired CHECK constraint, single-column
      index on `apns_token` for the dispatcher fan-out lookup
- [x] Dispatcher wiring: `APNS` joins the cascade as channel-type
      4; cascade order is now deterministic
      (APNs → Telegram → ntfy → Web Push)
- [x] Mock provider at `src/lib/notifications/senders/__mocks__/apns.ts`
      with queued per-token responses + recorded calls
- [x] Integration test
      `tests/integration/apns-dispatch.test.ts` — round-trip,
      hard-reject + cleanup, cascade fall-through (3 tests)
- [x] `POST /api/devices` accepts paired `apnsToken` +
      `apnsEnvironment`, enforces hex format, applies the
      cross-user-hijack guard at the APNs-token layer
      (409 `apns_token_owned_by_other_user`)
- Detailed report: `.planning/phase-W3-v1423-report.md`

## Wave 4 — OpenAPI + Coach schema + native auth + Coolify

### F5 — OpenAPI 3.1 generator + CI gate

- [ ] Tool wired (W1 decision)
- [ ] `pnpm openapi:generate` script emits
      `docs/api/openapi.yaml` from Zod schemas
- [ ] CI step compares generated vs committed; PR fails on drift

### F6 — Coach + Daily Briefing schema slot for new metrics

- [ ] `aiInsightResponseSchema.dailyBriefing.keyFindings[].sourceMetric`
      enum extends to include the new types
- [ ] `coach/snapshot.ts` extends `metrics` enum
- [ ] PROMPT_VERSION 4.22.0 → 4.23.0 (additive forward-compat)

### F7 — Native API hardening (refresh-token per-device)

- [ ] Refresh-token reuse-detection switches from "revoke all" to
      per-device-token revocation
- [ ] New route `GET /api/auth/me/devices` lists active sessions
      with last-seen + device-label
- [ ] New route `DELETE /api/auth/me/devices/:id` revokes one device
- [ ] iOS DTO doc for the device-management surface

### F8 — Coolify auto-deploy fix for real

- [ ] `COOLIFY_WEBHOOK` + `COOLIFY_TOKEN` GitHub repo secrets set
      (maintainer action; document in `.planning/coolify-auto-deploy-howto.md`)
- [ ] Coolify "Watch image registry for new digests" UI toggle
      flipped (maintainer action)
- [ ] Validation: tag push → fresh image deployed without host-side
      retag

## Wave 5 — Hygiene (H1-H7)

- [ ] H1 sentinel parser malformed-enum hardening
- [ ] H2 analytics-route unbounded `findMany` pagination
- [ ] H3 `<CoachDrawer key={prefill}>` controlled-prop refactor
- [ ] H4 per-user prompt-tuning surface (Coach settings cog return)
- [ ] H5 schema drift on `medication_schedules.days_of_week`
- [ ] H6 Pearson p-value normal-approx replacement
- [ ] H7 Coach helpful/unhelpful first-week observation view

## Wave 6 — Multi-agent QA + Product-Lead review

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review
- [ ] senior-dev review
- [ ] simplify
- [ ] Product Lead — v1.5 P1 (iOS first launch) plan refresh with
      concrete file paths now that backend contracts exist
- [ ] Reconcile CRITICAL + HIGH; defer MED/LOW

## Wave 7 — Release v1.4.23

- [ ] Pre-release verify
- [ ] Bump `package.json` 1.4.22 → 1.4.23 + CHANGELOG
- [ ] Release-merge develop → main
- [ ] Tag + push v1.4.23
- [ ] GHCR build green
- [ ] Coolify deploy (auto, if F8 works; else host-side fallback)
- [ ] /api/version=1.4.23 confirmed
- [ ] Production smoke + e2e workflow on main passes
- [ ] GH release
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1423-summary.md` (release brief)
- [ ] v1.5 P1 plan refresh recorded
