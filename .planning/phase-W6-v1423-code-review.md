# Wave 6 — Code review (v1.4.23)

## Summary

- **Files reviewed:** 38 production files across the v1.4.23 diff (29 commits, ~15.7k LOC delta) plus 4 phase reports, 5 migrations, both i18n bundles, and the regenerated OpenAPI spec.
- **Findings:** 0 CRITICAL · 2 HIGH · 6 MED · 6 LOW
- **Overall quality:** Strong. The four-wave plan landed end-to-end with production-grade code, comprehensive tests (2191 → 2223 unit, +8 integration), and an honest paper trail of trade-offs. Migrations are strictly additive, `apiHandler()` + `withIdempotency()` wraps are consistent, the Apple Health mapping table is exhaustive, the refresh-token per-device blast-radius is well-tested with the legacy null-deviceId fallback, and the sentinel-parser observability lands without leaking partial-bad-data into the rendered prose. The two HIGH findings are integration gaps rather than bugs in landed code: APNs has no production code path that creates the channel row it needs, and `POST /api/devices` has a same-user apnsToken-collision path that silently fans out to two device rows. The `feedback_charts_visual_identity.md` rule is honoured (no Recharts touch), the `feedback_marc_voice_english.md` rule passes scan (no AI/Claude/agent/marathon mentions outside `.planning/`), the `feedback_no_pii_in_user_facing.md` rule passes for the new GROUND RULE 12 (categories only, no figures/emails), the `feedback_react_query_key_collision.md` rule passes (new keys `["coach-prefs"]`, `["admin","coach-feedback"]`, `["admin","ai-quality"]` are unique), and the `feedback_cache_invalidate_on_new.md` rule passes (the settings sheet writes `setQueryData(["coach-prefs"], …)` so the next Coach turn picks up the change).

## CRITICAL

_None._

## HIGH

### HIGH-1 — APNs cascade is unreachable in production

- **Where:** `src/lib/notifications/dispatcher.ts:41-49` (channel lookup) + `src/app/api/devices/route.ts` (no APNS-channel creation) + the rest of the v1.4.23 W3 wiring.
- **What:** `dispatchNotification()` reads enabled `NotificationChannel` rows for the user and only enters the `case "APNS"` branch when one of those rows has `type === "APNS"`. Nothing in v1.4.23 (or earlier) creates a `NotificationChannel` row of type APNS. The integration test (`tests/integration/apns-dispatch.test.ts:110-115`) hand-creates the row with `prisma.notificationChannel.create({ type: "APNS" })`; production users who register an iOS device via `POST /api/devices` (apnsToken + apnsEnvironment land on the `Device` row) will never see APNs fire because the dispatcher never enters that branch.
- **Why:** Six commits of W3 scaffolding are dead code in production until either: (a) `POST /api/devices` upserts a matching `NotificationChannel` row when an apnsToken arrives, (b) the user is given a `/settings/notifications` toggle to opt in, or (c) a one-shot migration backfills the row for every existing iOS device. The v1.4.23 phase-W3 report calls APNs "shipped" but the cascade is unreachable through normal user flow.
- **Fix:** In `POST /api/devices`, after the cross-user-hijack guard passes and the device is upserted, also `prisma.notificationChannel.upsert({ where: { userId_type: { userId: user.id, type: "APNS" } }, create: { userId: user.id, type: "APNS", enabled: true, config: encrypt("{}") }, update: {} })`. Mirrors the existing Telegram-on-first-dispatch auto-migration (`dispatcher.ts:54-105`).

### HIGH-2 — Same-user apnsToken collision creates fan-out duplicate

- **Where:** `src/app/api/devices/route.ts:90-108` + `prisma/schema.prisma:822-836`.
- **What:** The cross-user-hijack guard for `apnsToken` filters with `NOT: { userId: user.id }`, so it only catches _other_ users' tokens. The same user can register a brand-new legacy `token` while supplying an `apnsToken` already attached to another of their own devices (e.g. they reinstalled iOS, the device id rotated, the apnsToken survived). Today the schema only has `@@index([apnsToken])` (no `@@unique`), so two of that user's `Device` rows now share the same `apnsToken`. `sendViaApns()` then iterates `findMany({ where: { userId, apnsToken: { not: null } } })`, fans out two pushes to the same physical device, and double-charges Apple's quota for one notification.
- **Why:** Every notification reaches the user's iPhone twice. Quota is finite; APNs throttles aggressively at scale.
- **Fix:** Either (a) make the apnsToken column globally unique (`@unique` on the schema, partial index over `apnsToken IS NOT NULL` in SQL), or (b) drop the `NOT: { userId }` clause from the hijack guard so any pre-existing apnsToken lookup also catches the same user, or (c) in the upsert path, when the apnsToken differs from the existing row's `apnsToken`, also `update` any other Device rows of the same user where `apnsToken` matches the new value to set them NULL. Option (a) is the cleanest — APNs tokens are device-scoped by Apple's contract.

## MED

### MED-1 — `loadApnsConfig()` cache pins a stale read across env changes in production

- **Where:** `src/lib/notifications/senders/apns.ts:100-167`.
- **What:** `cachedConfig` is module-scope and only reset by `resetApnsForTesting()`. Coolify-style env redeploys spawn fresh processes so the cache resets naturally, but if the operator rotates the APNs `.p8` key without restarting the worker (e.g. Coolify variable update + soft redeploy) the new key never lands. The `getProvider()` cache also persists.
- **Why:** Stale-key push failures look like Apple-side issues. The fix is either documenting the restart requirement loudly or having `loadApnsConfig()` re-read after a configurable TTL.
- **Fix:** Add a 60s/5min env-poll TTL on `cachedConfig`, OR document in `.env.example` + the W3 report that APNS\_\* changes require a worker restart.

### MED-2 — `POST /api/measurements/batch` reconciliation OR-clause re-queries the entire `toInsert` set

- **Where:** `src/app/api/measurements/batch/route.ts:226-261`.
- **What:** When `skipDuplicates: true` racey-absorbs rows (a duplicate batch lands in the same tick), the recheck path issues a second `findMany({ OR: toInsert.map(...) })` covering up to 500 entries. With 500 entries the OR clause has 1000 SQL parameters per side. This is fine under Postgres' 65k cap but the fall-back is allocated unconditionally — even the 99% no-race path pays the planning overhead because the early-return `if (racedDuplicates > 0)` only short-circuits the query, not the array allocation.
- **Why:** Performance smell rather than a bug. Race path is rare; bound is generous. Worth flagging because the iOS sync cursor exercise will trigger it under flaky-network retry.
- **Fix:** No action required for v1.4.23. v1.4.24 candidate: move the `OR` clause builder behind the `if (racedDuplicates > 0)` guard, and switch the recheck to fetch only the ids of rows that should have been inserted but came back with `skipDuplicates`'s implicit drop.

### MED-3 — SLEEP_DURATION unit silently changed from hours to minutes

- **Where:** `src/lib/validations/measurement.ts:53-57`, `prisma/migrations/0036_apple_health_measurement_types/migration.sql:12-17`.
- **What:** Migration 0036 says "advisory, no row mutation: SLEEP_DURATION shifts from hours to minutes... no production data exists for this enum value yet." The application `getUnitForType()` now reports `"minutes"` for this enum value. If any user manually entered a sleep value before v1.4.23 (the W1 research excluded this case but didn't enforce it), their pre-existing `7.5` (hours) row reads as `7.5 minutes` after the upgrade. Charts and analytics would then show degenerate numbers.
- **Why:** Silent data-shape change. The v1.4.20 weekly-report and Doctor-PDF surfaces would also misrepresent the unit on pre-v1.4.23 rows.
- **Fix:** Either (a) add a one-shot data migration that rewrites pre-v1.4.23 SLEEP_DURATION rows multiplying by 60 (gated on a `created_at < migration_date AND value < 24` heuristic), or (b) document the change loudly in CHANGELOG.md and add a runtime guard in `validateMeasurementRange()` that flags impossibly-low values (< 30 min for a sleep entry) so the anomaly catches stale rows.

### MED-4 — Coach `MessageThread` triggers `/api/auth/me/coach-prefs` GET on every drawer mount, regardless of settings interaction

- **Where:** `src/components/insights/coach-panel/message-thread.tsx:72-80`.
- **What:** The `useQuery({ queryKey: ["coach-prefs"] })` runs unconditionally (no `enabled` flag) so opening the Coach drawer always fires a GET even when the user never opens the settings sheet. The settings sheet's identical query at `coach-settings-sheet.tsx:71-80` is gated on `enabled: open`, so the two queries share the same key but trigger from different surfaces. TanStack Query dedups concurrent fetches so the practical cost is one GET per drawer mount + one GET per settings open (not two), but the always-on read happens even on accounts that never set a non-default preference.
- **Why:** Tiny perf nit. The defaults-only path could just read from the queryClient cache (or a no-fetch initialData) instead of pinging the API every drawer open.
- **Fix:** Add `staleTime: 5 * 60 * 1000` (or higher) to the `MessageThread`'s query so a single fetch per session covers both surfaces, and rely on the settings sheet's `setQueryData` to invalidate after a save (already in place at `coach-settings-sheet.tsx:107`).

### MED-5 — `lastFailureReason` in APNs sender captures the LAST device's reason regardless of whether it was permanent

- **Where:** `src/lib/notifications/senders/apns.ts:341-396`.
- **What:** The fan-out loop assigns `lastFailureReason = result.reason` on every failure, including transient ones, then surfaces that as the channel-state machine's `reason` string. With 3 devices where device A and B return `Unregistered` (deadDeviceId) and device C returns a transient 500, the dispatcher records the channel failure as `apns_unknown_failure` (or whatever C's reason was) instead of the `Unregistered` signal that drives the actual cleanup.
- **Why:** Misleading observability. The audit/wide-event tracker for "why did the channel get auto-disabled" reads the wrong reason.
- **Fix:** Track `lastFailureReason` separately for permanent vs transient outcomes; surface the permanent reason when `deadDeviceIds.length === devices.length`.

### MED-6 — `feedbackHelpful` and `feedbackThanks` keys exist at two i18n paths under different sibling sections

- **Where:** `messages/en.json:736 + 923` and `messages/de.json:736 + 923`.
- **What:** `insights.recommendation.feedbackHelpful` ("Helpful" / "Hilfreich") AND `insights.coach.feedbackHelpful` ("Helpful" / "Hilfreich") are duplicate keys in two different sections. Same for `feedbackThanks` ("Thanks for your feedback" / "Thanks for the signal."). The two siblings are distinct paths so the i18n locale-integrity test passes, but the visible copy is intentionally different ("Not helpful" vs "Not quite", "Thanks for your feedback" vs "Thanks for the signal.") despite serving identical UX semantics.
- **Why:** Style / consistency drift between Insights-recommendation feedback and Coach-message feedback. Either both should read "Not helpful" (clinical) or both should read "Not quite" (warm). Today they disagree.
- **Fix:** Pick one tone, replace the duplicates with a single `common.feedbackHelpful`/`common.feedbackUnhelpful`/`common.feedbackThanks` triplet, and re-import from both call sites.

## LOW

### LOW-1 — Two admin queries fetch the same `/api/admin/ai-quality` endpoint with different keys

- **Where:** `src/components/admin/ai-quality-section.tsx:65-72` (`["admin","ai-quality"]`) and `src/components/admin/coach-feedback-section.tsx:57-65` (`["admin","coach-feedback"]`).
- **What:** Both views read from the same endpoint but use distinct query keys. The two pages are never visible at the same time today (different `/admin/<slug>` routes), so the practical cost is one extra fetch per navigation between the two pages. Acceptable; calling it out for future cleanup.
- **Fix:** Optional — share a single `["admin","ai-quality-summary"]` key and let each section pluck its slice via a `select` callback.

### LOW-2 — `useResettableValue<T>` exported but the matching `nextResettableValue<T>` is exported separately

- **Where:** `src/components/insights/coach-panel/coach-drawer.tsx:80-113`.
- **What:** The hook exists for the H3 fix and the pure decision function is also exported, both for testing. The duplication is intentional (per the JSDoc) but it surfaces both as part of the public module. A future caller might import `nextResettableValue` instead of using the hook and get inconsistent behaviour.
- **Fix:** Mark `nextResettableValue` as `@internal` (or move it to a sibling test-helper file) so consumers can't import it accidentally.

### LOW-3 — Coach feedback admin section colour buckets ignore `dracula-yellow` token at-rest theme

- **Where:** `src/components/admin/coach-feedback-section.tsx:47-51`.
- **What:** The `helpfulRateColour` helper picks `text-dracula-yellow` for the 50-79% band. The Dracula palette ships `--dracula-yellow` but the admin sections elsewhere prefer `text-dracula-orange` for caution. Worth a one-liner note when the v1.4.24 design pass touches admin.
- **Fix:** Cosmetic; defer to design pass.

### LOW-4 — `parseChartTokens()` allowlist extends to 9 Apple Health metric tokens but no chart components ship for them

- **Where:** `src/lib/insights/chart-tokens.ts:36-46`.
- **What:** The allowlist accepts `metric:HEART_RATE_VARIABILITY` etc., but the comment at the top calls out that the chart components ship in v1.5. If the model emits one of these tokens before v1.5 lands, the prose is stripped of the token (correct) but the chart never renders. The user gets a sentence with a missing visual.
- **Fix:** Either narrow the allowlist back to the v1.4.23 surface OR add a chart component that renders an empty placeholder until v1.5.

### LOW-5 — `apnsEnvironment` falls back to `sandbox` for any value that isn't literally `"production"`

- **Where:** `src/lib/notifications/senders/apns.ts:348-349`.
- **What:** `device.apnsEnvironment === "production" ? "production" : "sandbox"` — any future enum addition (e.g. `"voip"`, `"alpha"`) would be silently routed through the sandbox gateway. Today the schema enforces only `sandbox|production` via Zod at the API boundary, but the DB column is a free-form `TEXT`. A future `apns_environment` value would silently break.
- **Fix:** Convert the `apnsEnvironment` column to a Postgres enum (or a CHECK constraint) so a write-side typo can't paint sandbox-routed rows.

### LOW-6 — Coach prompt prefs loaded with separate Prisma query inside `chat/route.ts` AND inside `buildCoachSnapshot()`

- **Where:** `src/app/api/insights/chat/route.ts:209-213` and `src/lib/ai/coach/snapshot.ts:263-267`.
- **What:** Two `prisma.user.findUnique({ select: { coachPrefsJson } })` calls per Coach turn — the route builds the system prompt with one read, the snapshot builder reads the same column for the exclude-metrics filter. Duplicated round trip; both values are identical at the same instant.
- **Fix:** Lift the `parseCoachPrefs` lookup into the route, pass the result into `buildCoachSnapshot(userId, scope, prefs)`. The snapshot helper already accepts a scope; an optional prefs arg keeps the API additive.

## Praise

- **Honest open-questions sections** — the W2/W3/W4 reports each carry a numbered iOS-DTO contract checklist (~13 questions consolidated in W4) that the iOS maintainer can walk through line-by-line. Rare to see this much explicit handoff documentation.
- **Strict-additive migration discipline** — five migrations (0036 → 0040) all use `IF NOT EXISTS`, every new column nullable, no enum reordering, `CHECK` constraints scope the new sleep_stage column to its enum value (mirroring the v1.4.20 glucose_context pattern). Zero risk of a deploy-time data loss.
- **Sentinel parser H1 split** — `coach.keyvalues.parse_partial` vs `coach.keyvalues.parse_failed` is exactly the right granularity for ops attribution, and the per-line `reasons` array (typed enum, no raw text) keeps Coach prose out of the wide-event log without losing the diagnostic signal.
