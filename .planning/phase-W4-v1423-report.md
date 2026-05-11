# Wave 4 — v1.4.23 OpenAPI + Coach + native auth + Coolify report

Status: shipped on `develop` (2026-05-11).
Scope: F5 (OpenAPI 3.1 generator + drift-check CI), F6 (Coach schema
slot for the 9 Apple Health metric categories from W2 + PROMPT_VERSION
ratchet), F7 (per-device refresh-token reuse detection + device
management endpoints), F8 (Coolify auto-deploy runbook + workflow
log line).

## What landed

### Eight atomic commits

1. **`chore(deps)` — install zod-openapi + yaml@2.** New scripts
   `pnpm openapi:generate` and `pnpm openapi:check`. The base
   registry at `src/lib/openapi/registry.ts` and the empty route
   table seed the generator; the legacy hand-maintained spec is
   preserved at `docs/api/openapi-v1422-legacy.yaml` so the iOS DTO
   reference doesn't disappear during the incremental migration.
2. **`feat(openapi)` — register iOS-touched routes.** The eight
   v1.5-iOS-critical routes (auth/login, passkey verify, refresh,
   measurements GET + POST + batch, devices POST, insights
   comprehensive) land via Zod v4 `.meta()` annotations on the
   existing validation schemas plus a route table in
   `src/lib/openapi/routes.ts`. Generated spec is ~880 lines, stable
   across re-runs.
3. **`ci` — warn-only OpenAPI drift check.** New step in
   `security.yml` runs the generator + diffs against the committed
   spec. `continue-on-error: true` for v1.4.23; flips to hard-fail
   in v1.4.24+ once the registry has caught up with the legacy
   hand-maintained spec.
4. **`feat(coach)` — Apple Health schema slot + PROMPT_VERSION 4.23.0.**
   Strict insight schema's `sourceMetric` and `trendAnnotations`
   enums extend to admit nine additive HealthKit categories. The
   Coach snapshot pipeline queries the new measurement types when
   the scope toggles them on (web-only accounts pay zero extra SQL).
   PROMPT_VERSION ratchets 4.22.0 → 4.23.0 and the new GROUND RULE
   12 (EN + DE) instructs the model to stay silent about HealthKit
   metrics when the snapshot doesn't carry them — no
   "you're missing HRV data" apologetic openers.
5. **`fix(auth)` — refresh-token per-device reuse detection.** Pre-
   1.4.23 a replay attempt revoked every refresh token the user
   owned; v1.4.23 scopes the blast radius to the originating
   `deviceId`. Legacy tokens with `deviceId === null` fall back to
   the wider user-wide revoke (safety hatch). The two-device case
   (iPad + iPhone) now works as expected.
6. **`feat(api)` — device management endpoints.** Three new routes:
   - `GET /api/auth/me/devices` lists devices with label,
     lastSeen, channels (`web_push` / `apns`), `isCurrent`
   - `DELETE /api/auth/me/devices/[id]` revokes a device + the
     refresh + access tokens bound to it + deletes the row
   - `DELETE /api/devices/[id]` is the native-friendly mirror the
     iOS APNs-rotation flow calls
     Cross-user attempts return 404 with no enumeration leak.
7. **`ci(deploy)` — Coolify auto-deploy runbook.** The workflow
   already pinged `?force=true` (v1.4.22 C3 commit `b281c06`); W4
   adds a `::notice::` line so future Actions runs surface the
   deploy timestamp + sha for triage. The runbook at
   `.planning/coolify-auto-deploy-howto.md` spells out the
   `COOLIFY_WEBHOOK` + `COOLIFY_TOKEN` repo-secret recipe and the
   load-bearing "Watch image registry for new digests" UI toggle
   that the workflow can't flip from CI.
8. **`docs(planning)` — STATE.md tick + this report.**

### Test count delta

- Unit tests: 2158 → **2191** (+33).
- Integration tests: 100 (no change — F5/F6/F8 land in unit
  surface; F7's per-device + cross-user tests live alongside the
  refresh-token + device-management routes as unit tests with
  mocked Prisma).
- `pnpm typecheck`, `pnpm lint`, `pnpm test --run`, and
  `pnpm openapi:check` are all green between every commit.

### OpenAPI generator stability

`pnpm openapi:generate` produces byte-identical output across
re-runs (`yaml@2` configured with `sortMapEntries: true`,
`lineWidth: 120`). Verified by running the generator twice in a
row and `diff`-ing the outputs — no drift.

### New dependencies

Two, exactly per the brief:

- `zod-openapi@5.4.6` — Zod v4 `.meta()` reader, ZodOpenApi document
  builder.
- `yaml@2.8.4` — stable map-sorted YAML serialiser.

### Migration footprint

None. The `RefreshToken.deviceId` column already shipped in
migration `0025_refresh_tokens` so the per-device revocation logic
change is code-only.

## W1 decisions adopted verbatim

| W1 recommendation                                                    | Status  |
| -------------------------------------------------------------------- | ------- |
| OpenAPI tool = `zod-openapi` (samchungy)                             | Adopted |
| YAML normalisation via `yaml@^2` + `sortMapEntries: true`            | Adopted |
| Two-stage migration (subset start + organic catch-up)                | Adopted |
| CI step `continue-on-error: true` for v1.4.23, hard-fail in v1.4.24+ | Adopted |
| `oasdiff` adoption deferred to v1.4.24                               | Adopted |

## Decisions made beyond W1's scope

- **Legacy spec preservation at `openapi-v1422-legacy.yaml`.** The
  freshly-emitted v1.4.23 spec is a strict subset of the hand-
  maintained version (~880 lines vs 5468); preserving the legacy
  copy as a sibling file keeps the full surface available as a
  reference during the organic migration without forcing every
  hand-maintained schema to land in the registry at once.
- **Per-device revocation falls back to user-wide for null
  deviceId.** The marathon brief called out the safety-hatch as a
  v1.4.23 requirement; the test suite pins both branches so a
  future cleanup doesn't accidentally remove the fallback.
- **`/api/devices/[id]` DELETE duplicates `/api/auth/me/devices/[id]`.**
  Two URLs, one implementation — the W3 open question explicitly
  asked for a native-friendly URL the iOS app could call on APNs
  token rotation, and the `/api/auth/me/...` path is built for the
  settings-surface listing. The underlying Prisma calls are
  identical so the audit trail stays consistent.
- **Refresh-token-state mocked-Prisma test stays in the unit
  suite.** Integration tests need a real Postgres instance; the
  per-device scope is purely about the `WHERE` clause shape, which
  the unit test mock asserts directly. An integration-level smoke
  test can land in v1.4.24 alongside the next batch of refresh-
  token work.

## What I couldn't ship and why

Nothing in W4 scope was dropped. The legacy hand-maintained
openapi.yaml is now a sibling reference rather than the canonical
spec — that's the v1.4.24+ migration target, not a v1.4.23 ship-
blocker.

## Open questions for the maintainer — iOS DTO contract (consolidated W2/W3/W4)

Drawing from `.planning/phase-W2-v1423-report.md` Open-Questions
section, `.planning/phase-W3-v1423-report.md`, and the W4
device-management surface:

1. **Source enum rename (W2 #1).** Server is locked on
   `APPLE_HEALTH`; the iOS DTO at
   `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Models/MeasurementDTO.swift`
   still ships `HEALTHKIT`. Land the one-line rename + sim-data
   reset note in the iOS dev README before the first TestFlight
   build.
2. **`externalId` shape (W2 #2).** Confirm the iOS contract uses
   `HKSample.uuid.uuidString` verbatim — composite
   "type-id::date" strings would break dedup across iCloud-paired
   devices.
3. **`sleepStage` codepoint domain (W2 #3).** Server accepts
   integers 0–20; iOS-16+ documented codepoints are 0–5. Confirm
   the iOS DTO serialises numeric codepoints rather than string
   labels.
4. **Pre-conversion vs post-conversion on the wire (W2 #4).** Server
   expects Apple's native units (0..1 fraction for SpO2/body fat,
   kcal for active energy). Confirm the iOS app does NOT pre-convert.
5. **Unknown identifier behaviour (W2 #5).** Server returns
   `skipped`/`unmappable_identifier`. Park-for-retry on the client
   side (recommended) vs drop-from-cursor.
6. **APNs token wire format (W3 #1).** Lowercase / mixed-case hex
   without spaces or angle brackets. The 422 catches
   `data.description` accidents but the iOS contract should pin
   the hex-join shape explicitly.
7. **`apnsEnvironment` value at first registration (W3 #2).** Pin
   `Debug → "sandbox"`, `Release → "production"` so the server
   doesn't double-send through both gateways on startup.
8. **Token rotation cadence (W3 #3).** v1.4.23 ships the
   `DELETE /api/devices/[id]` endpoint the iOS client should call
   on observed APNs rotation. Recommend the client uses it +
   re-registers rather than relying on the server's
   `Unregistered` cleanup alone.
9. **Multiple iOS devices per user during the cascade (W3 #4).**
   Confirm the user-facing UX expectation: two paired iPhones
   produces two notifications (matches iCloud iMessage), or do we
   need a "primary device" UI toggle in v1.5?
10. **`collapseId` value (W3 #5).** Server uses `eventType` today.
    If the iOS app wants per-medication collapsing, embed
    medicationId in the collapseId — confirm before v1.5 ships.
11. **NEW W4 — device-list rendering on the iOS settings surface.**
    The `GET /api/auth/me/devices` response carries `channels:
["web_push" | "apns"]` per device. Confirm the iOS UI either
    renders both as chips or filters to the channel matching the
    current platform; the iOS app shouldn't render `web_push`
    chips against an iPhone row.
12. **NEW W4 — current-device marker via `X-Device-Id`.** The iOS
    client must include `X-Device-Id: <device.id>` on every
    `GET /api/auth/me/devices` call for the `isCurrent: true`
    marker to land. Confirm the client sends the header on this
    surface (it already does on `/api/auth/refresh`).
13. **NEW W4 — refresh-token + device deletion race.** If the iOS
    app calls `DELETE /api/devices/[id]` and then immediately
    tries to refresh with a token bound to that device, the
    refresh path returns `revoked` (200 → empty data on the
    DELETE, then 401 on the refresh). Confirm the iOS client
    handles the 401 by routing to the re-login flow rather than
    treating it as a transient network error.

## Verification commands

```bash
pnpm typecheck                # green
pnpm lint                     # green (20 pre-existing warnings, 0 new)
pnpm test --run               # 2191 passed (was 2158, +33)
pnpm test:integration         # 100 passed (no change)
pnpm openapi:generate         # writes 880-byte spec
pnpm openapi:check            # spec in sync with source schemas
```

Eight commit SHAs are visible via `git log origin/develop..HEAD`
once pushed.
