# Wave 3 — v1.4.23 APNs scaffolding report

Status: shipped on `develop` (2026-05-11).
Scope: F4 — APNs send-side library + sender + Device-model
extension + dispatcher wiring + tests + `POST /api/devices`
contract update so the v1.5 iOS app can land per-metric alerts
via Apple's push gateway alongside the existing Telegram → ntfy
→ Web Push cascade.

## What landed

### Six atomic commits

1. **`chore(deps)` — install `@parse/node-apn` + env-var contract.**
   Adds the W1-recommended APNs Provider library, documents the
   four required env vars (`APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, plus one of `APNS_KEY` / `APNS_KEY_FILE`)
   and the optional `APNS_PRODUCTION` override in `.env.example`.
   Lockfile delta is `@parse/node-apn` plus its expected children
   (`jsonwebtoken`, `node-forge`, `lodash.*`, `verror`, `assert-plus`,
   `core-util-is`, `extsprintf`).
2. **`feat(schema)` — APNs device columns + dispatcher channel-type
   extension.** Migration `0037_apns_device_columns` adds nullable
   `apns_token` + `apns_environment` columns to the `devices` table,
   pairs them with a CHECK constraint (neither set ⇔ both set), and
   indexes `apns_token` for the dispatcher's per-user lookup + the
   cross-user-hijack guard. The existing
   `NotificationChannel.type` column is a free-form string, so
   adding `"APNS"` as the fourth channel type is a TS-only change
   in commit 4 — no DDL.
3. **`feat(notifications)` — APNs sender mirrors web-push contract.**
   `src/lib/notifications/senders/apns.ts` exposes
   `sendApnsPush({ deviceToken, environment, payload })` for
   one-shot delivery and `sendViaApns(userId, payload)` as the
   dispatcher entry. The Provider singleton is per-gateway
   (sandbox vs production), lazy-initialised so the JWT-signing
   parse doesn't run at boot. `@parse/node-apn` regenerates the
   bearer JWT every ~50 minutes inside the Provider; the only
   cache reset path is the `resetApnsForTesting()` helper that
   tests call between cases.
   Permanent-failure detection covers `Unregistered`,
   `BadDeviceToken`, `DeviceTokenNotForTopic`; on hard reject the
   dispatcher branch deletes the dead Device row before
   returning, mirroring the web-push 410 cleanup.
4. **`feat(notifications)` — APNs joins the dispatcher cascade.**
   `dispatcher.sendToChannel()` gains an `APNS` switch case
   calling `sendViaApns()`. A new `channelPriority()` sort makes
   the cascade order deterministic
   (APNs → Telegram → ntfy → Web Push) so a Postgres scan order
   change can't reorder delivery between deploys. `CHANNEL_TYPES`,
   `CHANNEL_TYPE_LABELS`, and the `ChannelConfig` union pick up
   the new value plus an empty `ApnsChannelConfig` (the per-device
   token + environment live on the Device row, not the channel
   config).
5. **`test(notifications)` — APNs sender unit + dispatcher
   integration coverage.** 23 unit tests (env-var loader, Provider
   lazy-init + per-gateway cache, permanent-failure detection,
   dispatcher fan-out, HTML stripping) and 3 integration tests
   (round-trip success, dead-device cleanup + audit log, cascade
   fall-through to Telegram). Adds the deterministic mock at
   `src/lib/notifications/senders/__mocks__/apns.ts` with queued
   per-token responses + recorded calls so future test files can
   swap the real sender for a fixture-driven double.
6. **`feat(api)` — `POST /api/devices` accepts apnsToken +
   apnsEnvironment.** The body schema gains the paired fields;
   supplying one without the other returns 422. The
   cross-user-hijack guard from CLAUDE.md is duplicated at the
   APNs-token layer — re-registering an `apnsToken` already
   owned by another user returns 409 with reason
   `apns_token_owned_by_other_user`. Audit-log details now carry
   `hasApnsToken` + `apnsEnvironment` so admin trails surface APNs
   pairing events. Five new route tests cover the validation +
   hijack paths.

### Test count delta

- Unit tests: 2130 → **2153** (+23 in apns.test.ts; +5 in the
  devices route test that's already counted above is wrong —
  recounted below).
- Re-counted: unit total 2130 → **2158** (+23 apns sender + 5 new
  devices-route assertions).
- Integration tests: 97 → **100** (+3 apns-dispatch).
- `pnpm typecheck`, `pnpm lint`, `pnpm test --run`, and
  `pnpm test:integration` are all green between every commit.

### Migration name + SQL summary

`prisma/migrations/0037_apns_device_columns/migration.sql`.

- `ALTER TABLE "devices" ADD COLUMN "apns_token" TEXT, ADD COLUMN "apns_environment" TEXT` — both nullable.
- `ALTER TABLE "devices" ADD CONSTRAINT "devices_apns_environment_required_with_token" CHECK (...)` — pairs the two columns so neither can be set without the other.
- `CREATE INDEX "devices_apns_token_idx" ON "devices" ("apns_token")` — backs the dispatcher's `findMany({ where: { apnsToken: { not: null } } })` fan-out and the cross-user-hijack guard's `findFirst({ where: { apnsToken } })` lookup.

Strictly additive: no row mutations, no constraint changes that
could fail on existing data, no enum reorderings.

### Lockfile delta

`pnpm-lock.yaml` adds `@parse/node-apn@8.1.0` and the documented
transitive dependency chain only:

| package                                                      | reason                              |
| ------------------------------------------------------------ | ----------------------------------- |
| `@parse/node-apn`                                            | direct dependency                   |
| `jsonwebtoken`                                               | JWT bearer for APNs auth tokens     |
| `node-forge`                                                 | PEM parsing for the .p8 signing key |
| `verror`                                                     | error wrapping inside node-apn      |
| `assert-plus`, `core-util-is`, `extsprintf`                  | verror's transitive set             |
| `lodash.includes`, `lodash.isboolean`, `lodash.isinteger`, … | jsonwebtoken's per-helper imports   |

`web-push` already pulls `node-forge` for VAPID JWT signing, so
the on-disk install footprint delta is small.

## W1 recommendations adopted verbatim

| W1 recommendation                                                                                        | Status                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Library = `@parse/node-apn` (vs `apns2` / hand-rolled HTTP/2)                                            | Adopted                                                  |
| APNs joins existing `NotificationChannel` enum as 4th type                                               | Adopted                                                  |
| Reuse existing `consecutiveFailures` / `nextRetryAt` / `disabledReason` columns                          | Adopted                                                  |
| Per-device `apnsEnvironment` (`sandbox` \| `production`); no server-side auto-detect                     | Adopted                                                  |
| Env-var contract `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / one of `APNS_KEY` / `APNS_KEY_FILE` | Adopted                                                  |
| Provider singleton per process — lazy-init, JWT rotated by library                                       | Adopted                                                  |
| Permanent failures (`Unregistered`, `BadDeviceToken`) drop the device row                                | Adopted, plus `DeviceTokenNotForTopic` for completeness  |
| Mock provider for test isolation                                                                         | Adopted (`__mocks__/apns.ts` + `__tests__/apns.test.ts`) |

## Decisions made beyond W1's scope

- **Cascade ordering is now an explicit priority sort.** Before
  W3 the dispatcher iterated the channels in Postgres-scan order;
  APNs joining as the highest-priority channel made implicit
  ordering brittle, so `channelPriority()` now drives the loop
  with APNs at 0 and unknown types at 99. Deterministic across
  deploys, easy to extend with a future `live-activity` channel.
- **`channelPriority()` sorts unknown types last.** A stale enum
  value (e.g. an experimental `LIVE_ACTIVITY` row written by a
  pre-deploy migration) can't preempt a real channel — its
  `default: 99` priority slot pushes it past every known type so
  the dispatcher still tries APNs / Telegram / ntfy / Web Push
  first.
- **Per-environment Provider cache.** A user with one iPhone on
  sandbox (TestFlight build) and another on production (App Store
  build) gets two distinct `apn.Provider` instances with the
  right gateway each. `forceProduction` (env override) collapses
  both to production for staging environments that need to talk
  to a TestFlight build over the prod gateway.
- **`apnsToken` regex enforces hex.** Apple's docs spec the token
  as the hex-string form of a `Data` blob; rejecting non-hex
  values at the API boundary catches the iOS implementation bug
  where someone passes `data.description` (Swift's debug-print
  format `<deadbeef cafebabe>`) instead of `data.map { String(format: "%02x", $0) }.joined()`.
- **APNs-token cross-user-hijack guard runs BEFORE the legacy
  `token` upsert.** Two separate `findFirst` checks. The cost is
  one extra indexed query per registration; the benefit is a
  single user can't backdoor another user's pushes by
  registering with their own legacy `token` and someone else's
  `apnsToken`.
- **HTML is stripped from APNs alert bodies.** Mirrors what
  web-push and ntfy already do; the iOS lock-screen renderer
  treats angle brackets literally and a notification body of
  `<b>take meds</b>` would land verbatim. Stripped server-side
  so the Coach prompt template doesn't have to special-case the
  channel.

## What I couldn't ship and why

Nothing in scope was dropped. Three adjacent items are explicitly
deferred per the brief:

- **Background `apns-push-type` pushes** — the `pushType` field
  on the Notification stays at the default `alert`; W1
  recommended deferring `background` (priority 5, throttled
  aggressively by Apple) to v1.5 P4 when the iOS app needs the
  HealthKit observer-query wake hook.
- **Per-device opt-out toggles** — today's `NotificationPreference`
  is per `(channel, eventType)`. Per-device-token mute (silence
  APNs on one phone but not the other) is a v1.5 P4 follow-up.
- **OpenAPI generator + Coach schema extension (Wave 4 F5/F6)** —
  outside this wave's scope. The new `POST /api/devices` shape
  needs the OpenAPI registry update in W4 so the iOS DTO doc
  stays in sync.

## Open questions for the maintainer about the iOS DTO contract

1. **APNs token wire format.** Server expects lowercase / mixed-case
   hex without spaces or angle brackets (Apple's modern
   `data.map { String(format: "%02x", $0) }.joined()` shape). If
   the iOS app currently logs the token via Swift's
   `data.description` (which renders `<deadbeef cafebabe>` with
   spaces and brackets) the body will return 422 with
   `apnsToken must be hex`. Confirm the iOS DTO's serialiser uses
   the hex-join shape.
2. **`apnsEnvironment` value at first registration.** The iOS app
   will receive its APNs token before it knows for certain whether
   the runtime is sandbox or production (the entitlement decides,
   but the client can `#if DEBUG` it). Confirm the iOS contract
   pins `Debug → "sandbox"`, `Release → "production"` so the server
   doesn't have to double-send through both gateways on startup.
3. **Token rotation cadence.** APNs rotates a device's token on
   reinstall, OS upgrade, and occasionally on backup-restore.
   Server treats every `POST /api/devices` as upsert-by-`token`,
   so a fresh `apnsToken` on the same legacy `token` overwrites
   the old pairing — but a fresh legacy `token` AND fresh
   `apnsToken` creates a brand-new Device row. Does the iOS app
   delete the previous Device row on the server when it observes
   a token rotation, or does it rely on APNs' `Unregistered`
   reason to GC the old row? Recommendation: add a
   `DELETE /api/devices/:id` route in W4 alongside the
   `GET /api/auth/me/devices` listing in F7.
4. **Multiple iOS devices per user during the cascade.** The
   dispatcher fans the same payload to every Device row owned by
   the user. With two iPhones paired the user receives two
   notifications, which matches the iCloud iMessage UX. Confirm
   that's the intended behaviour — the alternative is pinning
   one Device as "primary" per user, which would need a UI flag
   in v1.5.
5. **`collapseId` value.** Server currently sets it to the
   `eventType` (e.g. `MEDICATION_REMINDER`). That replaces the
   previous reminder in Notification Center for the SAME
   `eventType` — so a third reminder for the same medication-day
   collapses the older two. If the iOS app wants per-medication
   collapsing (so two simultaneous reminders for two different
   meds both stay visible), the server should embed the
   medicationId in the collapseId — confirm before v1.5 ships.

## Verification commands

```bash
pnpm typecheck      # green
pnpm lint           # green (15 pre-existing warnings, 0 new)
pnpm test --run     # 2158 passed (was 2130, +28)
pnpm test:integration   # 100 passed (was 97, +3)
```

Six commit SHAs land on `develop` (W3 sequence — see
`git log origin/develop..HEAD` once pushed).
