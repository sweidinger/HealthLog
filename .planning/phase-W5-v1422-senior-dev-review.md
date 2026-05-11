# Wave 5 — Senior-dev review (v1.4.22)

Reviewer: senior-dev lens, read-only
Branch: `develop` @ `363e73c` (18 commits ahead of `main`)
Inputs: phase-W1a/W1b/W2/W3/W4 reports + diff walk

## Summary

Architectural posture: **healthy, with one structural smell.** v1.4.22
is a polishing release; almost every chunk lives inside an existing
seam (TrendCard prop, CorrelationRow filter, TargetCard sub-component,
proxy redirect rule, sentinel parser as a side-module under
`src/lib/ai/coach/`). New abstractions are placed where they belong —
`keyvalues.ts` next to its only caller, `setOnboardingPendingCookie`
next to `createSession`/`destroySession`, the `Sparkline` component
inline in `targets/page.tsx` because it's used exactly once. Tests
land alongside the units they exercise. The one structural concern is
the C4 onboarding-cookie design: it writes a cross-cutting UX-flag
cookie from six different write sites (login, passkey-verify,
register, password-reset, /me, /onboarding/complete) and relies on
each to stay in sync with the DB column. That sync is correct today
but every future auth surface inherits the responsibility.

Findings: **0 CRITICAL · 2 HIGH · 5 MED · 4 LOW**

---

## CRITICAL

(none)

## HIGH

### H1 — `hl_onboarding` cookie sync is a write-fan-out with no

single point of truth (W4 C4)

**Where:** `src/lib/auth/session.ts:setOnboardingPendingCookie`,
called from six different routes (`login`, `passkey/login-verify`,
`register`, `password`, `auth/me`, `onboarding/complete`).

**Symptom:** every route that touches the user's session — present
or future — has to remember to call `setOnboardingPendingCookie`. A
new auth path (e.g. magic-link, OAuth, social login, the v1.5 SSO
work) that forgets to set the cookie will quietly skip the
proxy-level redirect and re-introduce the dashboard flash. The
helper is not enforced by the type system; `createSession` does not
require it; `destroySession` clears it but `createSession` doesn't
set it. The sync is by-convention, not by-construction.

**Architectural lift:** fold the cookie write into `createSession()`
itself (the call site already knows the user) so issuing a session
without onboarding state becomes impossible. The `/api/auth/me`
mirror remains useful for legacy sessions that predate the cookie
but should be a fall-back, not a primary write path. The
`destroySession` clear is already correctly co-located.

**Severity:** HIGH because the failure mode is silent (no test
catches "forgot to call the helper") and the regression it
re-introduces is the exact one C4 was designed to fix.

### H2 — Coach SSE handler stays inside the API route file even

though it's now ~480 LOC and combines five concerns (W3)

**Where:** `src/app/api/insights/chat/route.ts`.

**Concerns layered into one handler:**

1. Auth + body validation
2. Refusal detection + short-circuit (own SSE path)
3. Conversation resolution + persistence
4. Provider-chain orchestration + fallback handling
5. Sentinel parsing + provenance enrichment + streaming

The Wave 3 sentinel parser was correctly extracted to
`src/lib/ai/coach/keyvalues.ts`. Everything else still lives in
`route.ts`, which means the streaming construction
(`tokeniseForStreaming`, `encodeFrame`, `streamRefusal`,
`streamProviderError`, `start(controller) { try { … } finally {
controller.close(); } }`) is duplicated three times in one file. Two
of those copies enqueue different frame mixes (refusal: token + done;
provider-error: error only; happy path: tokens + provenance + done).
The pattern begs for a `buildSseStream(frames: CoachStreamEvent[])`
helper, ideally in `src/lib/sse.ts` next to `apiHandler`'s
neighbours.

**Why HIGH not MED:** the v1.5 iOS work is going to add another
streaming endpoint (likely the daily-briefing live regenerate). If
the SSE construction stays inline, that endpoint will copy-paste
this file's three try/finally blocks. The right time to extract is
before the second consumer lands.

---

## MED

### M1 — `analytics` route fetches every BP measurement ever, twice,

to compute `bpInTargetPctAllTime` (W2 A1)

**Where:** `src/app/api/analytics/route.ts:86-95`.

The route runs `prisma.measurement.findMany({ userId, type:
"BLOOD_PRESSURE_SYS" })` and the dia equivalent with no `where:
{ measuredAt: { gte: … } }` clause. For a tenant with several years
of paired BP readings the rows count balloons unboundedly. The
helper `computeBpInTargetWindows` then walks all of them to compute
the all-time pct alongside the 7/30-day windows. v1.4.22 A1 didn't
introduce this — v1.4.19 A1 did when it added the all-time field —
but A1 made the all-time number user-visible (third sub-row),
locking in the unbounded read.

**Fix:** at minimum bound by a sane horizon (e.g. last 5 years) or
materialise the all-time aggregate into a small per-user
`bp_target_aggregate` row, refreshed on measurement-write. The
dashboard hits this route on every page view and the Insights page
hits it again — same query.

### M2 — `targets` route's `sparklinePoints` allocates a `Map` per

type per request, called 7× per render (W4 C1)

**Where:** `src/app/api/insights/targets/route.ts:199-216` (×8 call
sites: WEIGHT, BP_SYS, PULSE, SLEEP_DURATION, BMI-derived, BODY_FAT,
ACTIVITY_STEPS — and the BMI path also allocates by mapping the
weight series).

Per-request the route does ~7 linear walks over `recentMeasurements`
(up-to-30-day rows), each filtering by type then bucketing by
day-key. For the live tenant this is fine; for a power user with
high-frequency activity sources (steps every hour) it grows fast.
The single Postgres-side `GROUP BY date_trunc('day', measured_at),
type` would replace seven JS-side passes with one. Existing pattern
in `latestEverByType` (single grouped query with `distinct` already
in use) shows the route author knows the optimisation.

Not a hot-path today (the page is rarely refetched), but it's the
shape of an N+M perf bug if a future surface starts polling `/api/
insights/targets`.

### M3 — `targets` page mutates server response inside a render

(W4 C1)

**Where:** `src/app/targets/page.tsx:713-735`.

`visibleTargets` is computed inside the render body via
`data.targets.filter(...).map(...)`, which is fine — but the `map`
spreads each glucose target and assigns a localised `label`,
re-converted unit, and converted `current/average30/range` numbers.
This is rebuilt on every render. The data is stable across renders
inside one fetch cycle, so a `useMemo([data, t, displayGlucoseUnit])`
saves the work and — more importantly — keeps the per-card ref
stable so React.memo (or any future virtualisation) actually fires.
Sparkline path computation is also re-run per render but lives
inside the `Sparkline` component where `points.length` is the only
input, so memoisation there is cheap.

### M4 — `provenanceFromJson` validates manually rather than using

the existing Zod schema (W3)

**Where:** `src/lib/ai/coach/persistence.ts:78-140`.

The `keyValues` shape has a perfectly good Zod schema
(`coachKeyValueSchema`, defined in `types.ts`) which the runtime
parser already uses (`keyvalues.ts:83-89`). The persistence
deserializer hand-rolls the shape check (`typeof candidate.label !==
"string"` etc.) for legacy compatibility. v1.4.22 added the
`keyValues` branch in this hand-rolled style, doubling the surface
area where the contract can drift. A single
`coachKeyValueSchema.array().safeParse(parsed.keyValues)` would
replace 35 lines with 1 and keep the validation contract in one
file.

The `windows` and `metrics` arrays are validated as `typeof === "string"`
without checking they're members of the enum union — a stale
metric-name from a pre-v1.4.20 row will type-cast through and hit the
UI. Same `safeParse` lift fixes both.

### M5 — Sentinel parser's "malformed" semantics conflate three

distinct conditions (W3)

**Where:** `src/lib/ai/coach/keyvalues.ts:170-179`.

`malformed = malformedClose || truncated || kept.length === 0`.
This works for the route's single use (annotate one wide-event), but
the three branches mean very different things:

- missing `---END---` → provider drift or token truncation
- 1KB cap hit → adversarial input or runaway model
- zero valid rows → format drift in the parsing layer

Bundling them under a single `boolean` makes ops dashboards unable
to distinguish "model returned junk" from "we had to truncate".
Four-state enum (`"ok" | "truncated" | "unclosed" | "empty"`) costs
nothing and gives ops the signal they'll want when the prompt drifts.

Test surface (`keyvalues-parse.test.ts`, 18 cases) doesn't pin the
malformed branches separately so a future refactor can quietly merge
behaviours.

---

## LOW

### L1 — `Sparkline` SVG path uses `viewBox + preserveAspectRatio="none"`,

which is fine for a 100×24 trace but stretches y-axis disproportionally
to x-axis on wide containers (W4 C1)

`targets/page.tsx:286-288`. On a wide desktop card the sparkline gets
stretched horizontally — the visual rate-of-change is misleading. Tiny
CSS `aspect-ratio: 100/24` on the wrapper would lock the trace to the
intended ratio. Not a correctness bug, but a "this looks weird on a
1440px viewport" polish miss.

### L2 — `setOnboardingPendingCookie` is `async` but does no async

work (W4 C4)

`src/lib/auth/session.ts:24`. The function awaits `cookies()` then
synchronously sets/deletes. The `await` chain pulls every caller
into `async` for no work — minor noise but the helper could be
synchronous if `cookies()` is resolved by the caller and threaded
through. Probably not worth changing now (matches the
`createSession` pattern), worth flagging as a v1.5 cleanup.

### L3 — `InsightsSectionNav` re-creates an `IntersectionObserver`

on every mount; the section-id list is a module-scoped constant so
the observer is conceptually a singleton (W2 A5)

`src/app/insights/page.tsx:1729-1747`. Single mount per page so the
practical cost is negligible, but the cleanup-then-recreate pattern
on hydration is slightly wasteful. Acceptable as-is; calling out
because the section nav is a candidate for extraction to its own
file (it's 70+ LOC of logic at the bottom of a 1700-line page
component) and at extraction time the observer should move with it.

### L4 — `targets` API ships an `as TargetItem` cast on the BP entry

to silence the `details` mismatch (W4 C1)

`src/app/api/insights/targets/route.ts:281`. The cast hides that
the BP target ships extra (sys-only) data without typing it. The
type system is being lied to in exactly the spot where the diastolic
plumbing goes through. Not introduced in v1.4.22 but the C1 work
landed alongside it without addressing the smell.

---

## Tech-debt accrual

**Things v1.4.22 paid down:**

- The v1.4.19 A3 `stripChartTokens` widening missed
  `recommendation-card.tsx:336`; W2 A6 closed that gap and added
  the regression test. Genuine bug retired, not just "covered up".
- The CorrelationRow now drops insufficient cards instead of
  rendering greyed placeholders (W2 A4) — this removes a
  conditional-render tree that was harder to reason about than
  the `filter().length` pattern that replaced it.
- `formatTokenName` regex broadened off `Z`-only ISO offsets
  (W4 D / D-CR-M-03). One less surprising wart.
- Bilingual CHANGELOG normalisation (W4 D2) reduces the edit
  surface every release.

**Things v1.4.22 added that need watching:**

- Hand-written validation in `provenanceFromJson` (M4) — second
  copy of the keyValues shape. Now a 2-place change lurking.
- Cookie write fan-out across 6 auth routes (H1) — fragile by
  convention.
- Three inline SSE-stream constructions in `route.ts` (H2) — at
  3 they're a lurking duplicate, at 4 they're a refactor.
- Section-nav inline at the bottom of a 1700-line page file
  (L3) — extraction is on the v1.4.23 implicit todo list.

**Status quo carried forward:**

- `analytics` route's unbounded BP findMany (M1) — known shape,
  not introduced here, just promoted in user-visibility.
- `targets/route.ts` 7-pass sparkline computation (M2) — same.
- `as TargetItem` cast (L4) — predates v1.4.22.

Net: **slight increase** in subtle debt (hand-rolled validation,
cookie sync convention, SSE template duplication). All three are
30-LOC fixes — the marathon's polish-not-refactor scope explains the
choice but the items shouldn't carry past v1.4.23.

---

## Things to keep

These are the architecture wins of v1.4.22:

1. **Sentinel parser shape.** Text-marker (`---KEYVALUES---` /
   `---END---`) over fenced JSON was the right call. The W1b research
   suggested fenced JSON; the maintainer overrode to text markers in
   the rewrite. The parser is composable (line-level
   `parseKeyValueLine` is independently testable, the block-level
   sentinel walk delegates to it), defensively bounded (1 KB +
   8 lines), and graceful-degrades to a no-op on missing/malformed
   blocks. `keyvalues.ts:107-180` is the cleanest module added in
   the marathon.

2. **Proxy onboarding redirect with a non-httpOnly UX-hint cookie.**
   Edge-runtime can't hit Prisma; the cookie pattern correctly
   solves the constraint without smuggling DB state through the
   wire. The "cookie is a UX hint, not a security signal" comment in
   `session.ts:18-22` makes the threat model explicit. The
   `/onboarding` self-loop guard (already in `PUBLIC_PATHS`) and the
   `pathname.startsWith("/onboarding")` belt-and-suspenders check
   are correct. The 7-test integration surface
   (`proxy-onboarding-redirect.test.ts`) pins exactly the right
   invariants.

3. **CorrelationRow row-fill via `filter` then conditional grid
   class.** `okResults.length === 1 ? "grid-cols-1" :
"md:grid-cols-2"` is the simplest expression of "1 → full-width,
   2-3 → 50/50". No layout primitive proliferation, no CSS grid
   `auto-fit` magic, just a length check. Same pattern repeats
   correctly in three places on the Insights page (BP-medication
   grid, weight-correlation grid, medications-per-day grid) — the
   in-page repetition is acceptable because each grid carries a
   different "show second card" predicate (`showMoodSection` vs
   `medications.length >= 2`).

4. **TrendCard third sub-value is opt-in via `avgAllTime !==
undefined`.** Other tiles leave the field undefined and the third
   `<span>` simply doesn't render — additive, no regression risk for
   the dozen existing call sites. The W2 A2 work is the textbook
   shape of a backwards-compatible component evolution.

5. **`provenance.keyValues` extends the existing envelope.** The
   W1b research's "Option A" (extend `CoachProvenance`) over
   "Option B" (new `evidence` field) was the right call. One
   decrypt boundary, one persisted blob, one DTO surface. The
   collapsible disclosure renders from the same field the
   in-flight stream emits — round-trip consistency with no
   migration.

6. **Test architecture stayed proportional.** Wave 3 added 17 unit
   tests + 2 integration tests for ~250 LOC of new code. The unit
   tests pin the parser and the prompt's literal text where it's
   load-bearing (PROMPT_VERSION, sentinel format); the integration
   tests pin the round-trip (sentinel persists + decrypts + appears
   in conversation reload) where the unit layer can't see it. No
   over-mocked unit tests of route logic; no integration tests of
   parser branches. The split tracks correctly with what each layer
   can actually verify.

---

## Cross-link to product-lead-review

- The H1 cookie-sync is a product-architecture concern: any new
  auth surface (SSO, magic link) needs the helper threaded in.
  Worth adding to the v1.5 product-lead checklist for "things to
  remember when adding an auth path".
- The H2 SSE-handler extraction is a v1.4.23 candidate worth
  surfacing to product-lead before any new streaming endpoint
  lands.
- W2 A5 "Zusammenhänge" rename is a UX call that already passed
  through product-lead in W1a; flagging here only that the
  decision is documented in the W2 report and matches the
  research-backed naming heuristic from W1b.
- The Coach prompt rewrite (W3) is the single biggest user-facing
  voice change in the release — product-lead-review should sample
  3-5 live conversations against the new prompt and confirm the
  warmth/restraint balance lands as the W1b research predicted.
