# v1.4.23 marathon — state log

Status: kickoff
Last update: 2026-05-10T23:00+02:00

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

- [ ] Add `HEART_RATE_VARIABILITY`, `SLEEP_DURATION_DETAILED`,
      `RESTING_HEART_RATE`, `STEP_COUNT`, `ACTIVE_ENERGY_BURNED`,
      `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `VO2_MAX`
- [ ] Prisma migration `0036_apple_health_measurement_types`
- [ ] Unit conversions documented in
      `src/lib/measurements/apple-health-mapping.ts`

### F2 — `MeasurementSource` enum expansion

- [ ] `apple_health` joins existing `manual / withings / moodlog`
- [ ] UI badges + ingest validators + analytics segmenters updated

### F3 — `POST /api/measurements/batch`

- [ ] New route, idempotent via `Idempotency-Key`
- [ ] Validates batch ≤ 500 entries
- [ ] Dedupes via `(userId, type, source, externalId)` composite
- [ ] Returns per-entry status + idempotency-replay-safe
- [ ] Integration test (testcontainers Postgres)

## Wave 3 — APNs scaffolding (F4)

- [ ] Library install + lock-file (W1 decision)
- [ ] `src/lib/notifications/senders/apns.ts` (send-push helper)
- [ ] Env-var contract (`APNS_KEY_ID`, `APNS_TEAM_ID`,
      `APNS_KEY_FILE`, `APNS_BUNDLE_ID`)
- [ ] `Device` Prisma model extension: `apnsToken` field +
      `apnsEnvironment` (sandbox/production)
- [ ] Dispatcher wiring: APNs joins the existing notification
      cascade alongside Telegram + ntfy + Web Push
- [ ] Mock provider for tests
- [ ] Integration test for batched APNs send

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
