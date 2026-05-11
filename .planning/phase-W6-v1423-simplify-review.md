# v1.4.23 Wave 6 — Simplify review

Reviewed: develop @ 72829b1. Scope per the brief:

- W2 — `apple-health-mapping.ts`, `measurements/batch/route.ts`, sleep-stage analytics in `analytics/route.ts`
- W3 — `senders/apns.ts`, dispatcher cascade extension, `devices/route.ts`
- W4 — `openapi/registry.ts`, `auth/refresh-token.ts`, `me/devices/*`, Coach prompt-builder reading new prefs (`snapshot.ts`, `system-prompt.ts`)
- W5 — sentinel-parser obs (`keyvalues.ts`), chunked-aggregate (`fetchBpSeriesChunked`), controlled-prop drawer (`coach-drawer.tsx`), coach-prefs route + UI (`coach-prefs/route.ts`, `coach-settings-sheet.tsx`), thumbs feedback (`messages/[id]/feedback/route.ts`, `message-thread.tsx`, `feedback-aggregator.ts`)

## Summary

Total findings: 5 apply-yes · 4 apply-maybe · 3 apply-no

## apply-yes (clear wins)

### S-01 — Two device-DELETE routes are byte-identical except for one audit detail

**Files**: `src/app/api/devices/[id]/route.ts:26-86` and `src/app/api/auth/me/devices/[id]/route.ts:31-94`
**Why**: Both files run the same five-step cascade (ownership lookup → revoke refresh tokens → revoke paired access tokens → delete device → audit + annotate). The only structural difference is `via: "ios.rotation"` in one audit detail and the action label (`devices.revoke` vs `auth.me.devices.revoke`). ~60 lines duplicated. Extract a `revokeDeviceCascade(userId, deviceId, opts)` helper in `src/lib/devices/revoke.ts` and have both routes call it. Security-adjacent but no decision logic moves — the helper is a pure data-flow extraction. (Reviewed against the brief: this is duplication of _implementation_, not of a security boundary; the cross-user 404 + revoke-then-delete order stays bit-identical.)
**Before** (≤8 lines):

```
// src/app/api/devices/[id]/route.ts AND src/app/api/auth/me/devices/[id]/route.ts both contain:
const liveRefreshTokens = await prisma.refreshToken.findMany({...});
await prisma.refreshToken.updateMany({ where:..., data: { revokedAt }});
const accessHashes = liveRefreshTokens.map(...).filter(...);
if (accessHashes.length > 0) await prisma.apiToken.updateMany({...});
await prisma.device.delete({ where: { id: device.id } });
await auditLog("devices.revoke", { userId, details: {...} });
```

**After** (≤8 lines):

```
// src/lib/devices/revoke.ts
export async function revokeDeviceCascade(userId: string, deviceId: string,
  opts?: { auditAction?: string; via?: string }) {
  const device = await prisma.device.findUnique({...});
  if (!device || device.userId !== userId) return null;
  // ... shared cascade body ...
  return { id: device.id, refreshTokensRevoked, accessTokensRevoked };
}
// each route shrinks to: const r = await revokeDeviceCascade(...); if (!r) return apiError("Device not found", 404);
```

### S-02 — `openapi/registry.ts` lazy `require()` adds eslint-disable + unsafe cast for no benefit

**File**: `src/lib/openapi/registry.ts:65-75`
**Why**: The doc-block claims the `require()` keeps `openApiBase` "usable from contexts that shouldn't pull every Zod schema". That's hypothetical — the only caller is `scripts/generate-openapi.ts` and `scripts/check-openapi.ts`, both of which call `buildOpenApiDocument()` which always loads `./routes`. The lazy form costs an eslint-disable, an `as` cast, and an extra layer of typing. A static import is cleaner and safer.
**Before** (≤8 lines):

```
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { openApiPaths, openApiComponents } = require("./routes") as {
    openApiPaths: ZodOpenApiObject["paths"];
    openApiComponents: ZodOpenApiObject["components"];
  };
  return createDocument({ ...openApiBase, paths: openApiPaths, components: openApiComponents });
}
```

**After** (≤8 lines):

```
import { openApiPaths, openApiComponents } from "./routes";
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  return createDocument({ ...openApiBase, paths: openApiPaths, components: openApiComponents });
}
```

### S-03 — Coach-prefs query duplicated between settings sheet and message thread

**Files**: `src/components/insights/coach-panel/coach-settings-sheet.tsx:71-80` and `src/components/insights/coach-panel/message-thread.tsx:72-80`
**Why**: Both components ship the same `useQuery({ queryKey: ["coach-prefs"], queryFn: fetch("/api/auth/me/coach-prefs") → env.data })` block, with subtly different fallback shapes (one throws on `!ok`, the other returns `DEFAULT_COACH_PREFS`). Extract a single `useCoachPrefs()` hook in `src/hooks/use-coach-prefs.ts`. Removes ~15 lines and prevents drift on the next prefs surface (settings tab? Insights cog?). The query cache key already standardises behaviour at runtime; the hook just removes the literal duplication.
**Before** (≤8 lines):

```
// settings-sheet AND message-thread each define:
const { data } = useQuery({
  queryKey: ["coach-prefs"],
  queryFn: async () => {
    const res = await fetch("/api/auth/me/coach-prefs");
    if (!res.ok) /* one throws, the other returns defaults */;
    const env = (await res.json()) as { data: CoachPrefs };
    return env.data;
  },
});
```

**After** (≤8 lines):

```
// src/hooks/use-coach-prefs.ts
export function useCoachPrefs(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["coach-prefs"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me/coach-prefs");
      if (!res.ok) return DEFAULT_COACH_PREFS;
      return ((await res.json()) as { data: CoachPrefs }).data;
    },
    ...opts,
  });
}
```

### S-04 — Snapshot's nine `wantsX = sources.has("X")` booleans are redundant

**File**: `src/lib/ai/coach/snapshot.ts:302-318` and the `wantedTypes.push(...)` ladder at 323-335
**Why**: The Apple Health table at 517-527 already enumerates `(source, type)` pairs. The block at 302-335 reproduces the same enumeration twice (once as `wantsX = sources.has("X")` booleans, once as `if (wantsX) wantedTypes.push(...)`). Two parallel ladders for the same data. Drive everything from a single `METRIC_TYPE_MAP: Record<CoachScopeSource, MeasurementType[]>` constant — collapse the 13-line `wantedTypes` build into a 3-line `flatMap`, drop the `wantsHrv/wantsSleep/wantsRestingHr/wantsSteps/wantsActiveEnergy/wantsFlights/wantsDistance/wantsVo2Max/wantsBodyTemp` booleans entirely (the `appleHealthBlocks` table already gates on `enabled: sources.has(...)`).
**Before** (≤8 lines):

```
const wantsHrv = sources.has("hrv");
// ...8 more booleans...
const wantedTypes: string[] = [];
if (wantsBp) wantedTypes.push("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA");
// ...11 more if-pushes...
```

**After** (≤8 lines):

```
const METRIC_TYPES: Record<CoachScopeSource, MeasurementType[]> = {
  bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"], weight: ["WEIGHT"], pulse: ["PULSE"],
  mood: [], compliance: [], hrv: ["HEART_RATE_VARIABILITY"], sleep: ["SLEEP_DURATION"],
  resting_hr: ["RESTING_HEART_RATE"], steps: ["ACTIVITY_STEPS"], /* ...etc */
};
const wantedTypes = Array.from(sources).flatMap((s) => METRIC_TYPES[s] ?? []);
```

### S-05 — `messages/[id]/feedback/route.ts` annotates the same action three times

**File**: `src/app/api/insights/chat/messages/[id]/feedback/route.ts:60-167`
**Why**: Five `annotate({ action: { name: "insights.coach.message.feedback" }, meta: {...} })` calls in one handler, all with the same action name and only the `meta.outcome` field varying. Hoist the action name to a single `annotate({ action: ... })` at the top, then use single-arg `annotate({ meta: { outcome: "..." } })` calls (the WideEvent merges them). Saves five `action: { name: ... }` repetitions and makes "what does this route annotate?" a one-line answer.
**Before** (≤8 lines):

```
if (!rl.allowed) {
  annotate({ action: { name: "insights.coach.message.feedback" }, meta: { outcome: "rate_limited" } });
  return apiError(...);
}
// ...four more identical action-name annotations differing only in `outcome`...
```

**After** (≤8 lines):

```
annotate({ action: { name: "insights.coach.message.feedback" } });
if (!rl.allowed) { annotate({ meta: { outcome: "rate_limited" } }); return apiError(...); }
// ...later sites just annotate the new meta...
annotate({ meta: { outcome: "created", rating: body.rating, providerType: ... } });
```

## apply-maybe (judgment calls)

### S-M1 — `useResettableValue` + `nextResettableValue` in `coach-drawer.tsx`

**File**: `src/components/insights/coach-panel/coach-drawer.tsx:80-113`
**Status**: maybe. The pattern is correct (per React docs) and the comment is excellent. But (a) `nextResettableValue` is exported solely for unit testing yet `useResettableValue` already encodes the same comparison, and (b) the same pattern is duplicated again in `coach-settings-sheet.tsx:87-94` (`lastSeenPersisted` + `if (persisted !== lastSeenPersisted) ...`). Extract `useResettableValue` (and only that hook) into a shared `src/hooks/use-resettable-value.ts` and reuse from both — but it's a _newly-introduced abstraction_ so the brief asks us to give it room. Defer until a third caller appears.

### S-M2 — Snapshot's `byType()` filters a flat array nine+ times

**File**: `src/lib/ai/coach/snapshot.ts:350-356, 359-360, 378, 392, 530`
**Status**: maybe. Each `byType(t)` call walks the full `measurementRows` array (could be a few hundred rows after the type-IN narrowing). Pre-bucket into `Map<string, Row[]>` once and look up by key — O(N) once vs O(N×K). Mild perf win; lookup-shape change. Only worth it if a profile shows snapshot construction near the budget. Defer.

### S-M3 — Apple-Health mapping table's `convertToDbUnit: (v) => v` repeats 11×

**File**: `src/lib/measurements/apple-health-mapping.ts:91-242`
**Status**: maybe. Eleven of thirteen entries spell out `convertToDbUnit: (v) => v`. The doc above the table already calls out the two exceptions (oxygen + body fat). Make `convertToDbUnit` optional in `AppleHealthMapping` and have `mapAppleHealthEntry()` default to the identity. Saves ~11 lines but adds a typing nuance and a subtle "did the author forget?" question for new entries. Marginal.

### S-M4 — `dispatcher.ts` `channelPriority()` switch could be a Map

**File**: `src/lib/notifications/dispatcher.ts:268-291`
**Status**: maybe. A `const PRIORITY: Record<string, number> = { APNS: 0, TELEGRAM: 1, NTFY: 2, WEB_PUSH: 3 }` + `PRIORITY[type] ?? 99` is two lines vs eleven, and the narrative comment block above stays. The switch is technically more grep-friendly when adding a new channel. Coin flip; the brief excludes the dispatcher's _security_ paths but a sort-key map is cosmetic, not security-shaped.

## apply-no (rejected — explanation)

### S-N1 — `apns.ts` sender + `loadApnsConfig` validation ladder

**Why**: Security surface — APNs sender is explicitly excluded by the brief. The `anySet` / `allSet` validation guard, the lazy provider cache, the `PERMANENT_APNS_REASONS` set, and the per-device dead-cleanup loop are all defence-in-depth that should not be reshaped. The 411 LOC carry the contract; leave it.

### S-N2 — `refresh-token.ts` rotation flow

**Why**: Security surface (refresh-token reuse-detection scoped to deviceId in v1.4.23 is the load-bearing change). The `where: { ..., deviceId }` vs `where: { ... }` ternary at line 129-132 reads as deliberate per-device scoping with a documented null-fallback to user-wide; collapsing it would risk losing the safety property the comment explains.

### S-N3 — `keyvalues.ts` sentinel parser

**Why**: Brief explicitly excludes the sentinel parser (security-adjacent — input from LLM). The W5 H1 work added typed `SentinelMalformedReason` codes precisely because the silent-drop path was a problem; the seven-cap defence (1 KB, 8 lines, label cap, value cap, missing-colon, schema, byte-overflow) is exactly the kind of layered guard that should not get cleverer. The block-vs-line malformed-flag union (lines 260-270) reads as deliberate prose, not duplication.

## Notes / push-back

- **`measurements/batch/route.ts:80-92` raw-body `entries.length` check before Zod parse.** Looks duplicative with `batchPayloadSchema.entries.min(1)` but the comment explains it: "distinguish too-many-entries from validation-failed so the client surfaces a useful diagnostic". The error-code (`coach.batch.too_large`) is a real wire contract. Keep verbatim.
- **`measurements/batch/route.ts:226-261` raced-duplicate reconcile path.** Reads heavy but the comment is exemplary and the path covers a real edge case (two batches for the same APNs token landing in the same tick). Idempotency surface — the brief excludes it. Keep.
- **`analytics/route.ts:540-622` weekend medication-compliance shift logic.** The comment "shift each event's scheduledFor and takenAt forward by 7 days so the helper's internal `now` anchor still captures the same logical 30 days" tells the whole story; the duplication of `medicationCompliance30` and `…Previous` is intentional symmetry. Don't fold.
- **`coach-feedback-section.test.tsx` + `feedback-aggregator.ts` `buildCoachFeedbackBuckets`.** Reads cleanly; nothing to simplify. The encoded `coach:tone=warm:verbosity=default` `metricSourceType` carries the slice, the regex parser walks it back out — correct shape for the polymorphic table.
- **`coach-drawer.tsx` `isDefault` scope-equality check (line 190-193).** Three-condition AND with an `every()` reads slightly fiddly but accurately encodes "same window AND same source set". A `setsEqual()` helper would be ~3 lines saved at the cost of a new util — not worth pulling.
