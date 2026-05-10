# Phase D — Code review (v1.4.20)

Reviewed against `develop` HEAD `ded0b38`. v1.4.20 = Insights redesign + AI Coach (Wave B, 27 commits, +14883/-359 LOC across 94 files).

## Summary

- Files reviewed: 38 source / route / lib files + 16 test files + 1 schema migration + i18n bundles
- Findings: 0 CRITICAL · 4 HIGH · 9 MED · 6 LOW
- Overall quality: Strong. The Coach surface is the most security-conscious slice in the repo to date — bearer/cookie parity, AES-GCM-at-rest with key rotation, label-only provenance, prompt-injection regex bank, per-user daily token budget, 404-not-403 cross-user existence guard, idempotent first-turn POSTs but **not** follow-up turns. Correlation maths includes the `n >= 14` and `p < 0.05` bar, conservative non-causal phrasing baked into both the lib and a unit test, with EmptyState fallback for below-threshold results. Test coverage is meaningful (parser fuzz, encryption round-trip, ownership, budget clamp, weekday ANOVA outlier, ISO week round-trip, score band/clamp/null-distribution). The four HIGH findings are real bugs but each is recoverable; nothing here blocks the release.

## CRITICAL

_None._

## HIGH

### CR-HIGH-01 — Coach SSE error frames return 503 but the streaming hook never reads them
**File**: `src/app/api/insights/chat/route.ts:412-426` and `src/components/insights/coach-panel/use-coach.ts:293-302`

**What**: When the provider chain fails or the user has no provider, `streamProviderError()` returns a `Response` with `status: 503` whose body is an SSE stream containing `{type:"error",code:"coach.provider.unavailable"}`. On the client, `useSendCoachMessage` checks `if (!response.ok || !response.body)` and short-circuits with `errorCode: \`coach.http.${response.status}\``. The stream — including the error frame the route emitted — is never read. The user sees `coach.http.503` which `MessageThread.safeError` falls back to `t("insights.coach.errorProvider")`, so the *visible* copy is OK, but the rich `code` channel on the SSE event is wasted, and the route emits a body that no current client consumes.

**Why**: The route's SSE error path is dead code from the client's perspective. If a future iteration adds richer error handling that depends on parsing the `error` frame's `code`, it will silently never fire. This is also a footgun for the next maintainer reading the route — they'll assume the client honours the SSE error.

**Fix**: Either (a) flip the response to `status: 200` so the client reads the stream and extracts the structured error code, or (b) drop the SSE body in `streamProviderError` and return a JSON envelope with the error code so the client's HTTP-status branch sees a structured payload.

### CR-HIGH-02 — `useSendCoachMessage` re-creates `send` every render and double-abort risk on parent re-render
**File**: `src/components/insights/coach-panel/use-coach.ts:240-382`

**What**: `useSendCoachMessage` accepts `opts: UseSendCoachMessageOptions = {}` and lists `[opts, queryClient]` in `send`'s `useCallback` deps. The drawer mounts the hook with an inline object literal `useSendCoachMessage({ onDone: (resolvedId) => setCurrentConversationId(resolvedId) })` (`coach-drawer.tsx:106-110`). Every render creates a new object identity, so `send` is re-memoised every render. While streaming, no caller invokes `send` so the in-flight reader keeps running, but if the user clicks "send" twice in quick succession across two renders, the second `send()` call invokes `abortRef.current?.abort()` and tears down the first stream — a behaviour the comment ("Cancel any prior in-flight request") does intend, but the user has not opted into it.

**Why**: Less of a correctness bug than a deps-correctness smell that bites the next person who edits the hook. A future ref-pattern change could turn the per-render `send` identity into a real bug (e.g. effects that depend on `send`).

**Fix**: Stash `opts` (or just `opts.onDone`) into a `useRef` updated in a render-effect-free way, and pass `[queryClient]` to the `useCallback` deps. Alternatively, drop `opts` from the deps and reference the latest via the ref.

### CR-HIGH-03 — Idempotency wrapper double-reads the request body
**File**: `src/app/api/insights/chat/route.ts:429-450`

**What**: The outer `apiHandler` clones the request, parses its JSON to detect `conversationId`, and **then** dispatches into `handleChatRequest(request)` (the original) which calls `request.json()` again at line 132. Both paths read the body. `request.clone()` ostensibly returns an independent stream, so the original `request` is still fresh — but the comment block in the route admits the cloning is hot-path logic ("validation will surface the issue inside the handler"). If a future runtime tightens body-stream semantics or `withIdempotency` itself begins consuming the body, the double-read becomes silently wrong (handler sees an empty body, surfaces 400). There is also no body-size cap on the clone read; a 4 KB body is fine but a runaway 10 MB JSON would be parsed twice.

**Why**: Streaming-body parsers are notoriously version-fragile. The current Next.js + Node combo allows the clone, but the reliance is implicit. Worse, when `conversationId` is present the handler runs *without* idempotency protection — a duplicate POST with the same `Idempotency-Key` to an existing thread will replay the provider call and double-bill the budget.

**Fix**: Read + parse the body **once** at the top of the handler, then pass the parsed object into the inner function; or hoist the conversationId parse into a tiny helper that operates on a cached JSON read. Document that follow-up turns deliberately skip idempotency, or apply it (the tests in `coach-conversations.test.ts` don't probe this case).

### CR-HIGH-04 — `streamProviderError` parameter typed as `ReturnType<typeof Object.assign>` (≈ `any`)
**File**: `src/app/api/insights/chat/route.ts:406-410`

**What**: `streamProviderError({ conversationId, snapshot: ReturnType<typeof Object.assign>, code })` — the `snapshot` parameter is typed `ReturnType<typeof Object.assign>` which TypeScript widens to `any`. This is a `noImplicitAny` escape hatch that defeats strict mode. The function never actually uses `snapshot` (look at the body — it only encodes the error frame), so the type tells the wrong story too.

**Why**: Strict-mode `any` leak — violates the project's `tsconfig.strict = true` posture documented in CLAUDE.md. Once a downstream caller passes a real provenance value, the wrong shape will be silently accepted.

**Fix**: Drop the `snapshot` parameter entirely (it is unused), or type it as `CoachProvenance` from `@/lib/ai/coach/types` if the function is meant to attach provenance to the error frame in a future commit.

## MED

### CR-MED-01 — `useEffect` for streaming auto-scroll lists `streaming?.content` but not `streaming` identity
**File**: `src/components/insights/coach-panel/message-thread.tsx:72-78`

**What**: The auto-scroll effect depends on `[messages.length, streaming?.content]`. When the parent flips from one streaming session to a fresh one with content `""`, the effect won't fire (length unchanged, content unchanged from "" → ""), and the viewport may stay scrolled mid-thread. Mostly harmless because `messages.length` will tick when a new persisted message lands, but the dependency is brittle.

**Fix**: Add `streaming?.inProgress` to the dep list (or track a turn counter).

### CR-MED-02 — `bandFromInterval` can return a misleading "high" label on a tight CI around r ≈ 0
**File**: `src/lib/insights/correlations.ts:558-570`

**What**: `bandFromInterval([-0.05, 0.10])` → width 0.15 → label "high". A "high confidence" chip on a near-zero correlation reads as "we're confident the effect is meaningful" but the CI just confirms the effect is small. The card is gated by `pValue < 0.05` upstream which prevents the worst case, but a borderline-significant near-zero r could surface a "High confidence" chip alongside an interpretation that says "do not move together strongly".

**Fix**: Demote the chip to "moderate" when the CI bracket straddles zero, or rename the chip to something like "tight CI" / "wide CI" so the language doesn't conflate "narrow CI" with "meaningful effect".

### CR-MED-03 — Pearson p-value uses normal-approximation across the entire surfacing range
**File**: `src/lib/insights/correlations.ts:182-199`

**What**: `twoSidedPFromT(absT, df)` uses `2 * (1 - normalCdf(absT))` for `df ≥ 12` and a "crude correction" `* 0.85` below that. Comment claims accuracy "to within ~0.005 over the surfacing range" but at the n=14 (df=12) gate the t-distribution's heavier tail can put a true p≈0.04 result at p≈0.025 under the normal approximation — a 1.6× understatement of significance. The threshold-crossing risk is real.

**Fix**: Either pull in a tiny incomplete-beta implementation (e.g. ~30 LOC) or raise the gate to df ≥ 20 to keep the normal approx honest.

### CR-MED-04 — `weightTrendAlignment` uses ±2 kg target band derived from a single number, not the user's actual band
**File**: `src/lib/analytics/health-score.ts:289-294`

**What**: `deriveWeightTarget(targetKg)` always returns `{ min: target-2, max: target+2 }`. The user's stored `weightTargetKg` is a point estimate; the score then awards 100 only when *latest* falls in the ±2 kg band. A user with a stable target weight of 80 kg and a steady 79 kg actual reading scores 100; the same user at 77 kg scores < 100 even with a flat trend. There's no clinical basis for ±2 kg specifically — pulling from the existing `value-bands` infrastructure (which has a real green/orange band defined per-user via `buildWeightRangeFromHeight`) would be more honest.

**Fix**: Reuse `buildWeightRangeFromHeight(user.heightCm)` (already imported in the analytics route) and pass the green band as the `target`. Optional: fall back to ±2 kg only when `heightCm` is unset.

### CR-MED-05 — `computeUserHealthScore` re-uses identical `bpInTargetPct` for both current and previous snapshot
**File**: `src/app/api/analytics/route.ts:509-520`

**What**: The "vs last week" delta is supposed to compare against a 7-day-shifted snapshot, but the BP component is held constant ("we'd need to rewind the all-time aggregate"). Three of the four pillars move; one is frozen. When the BP component dominates the weight (0.30 of 1.00), the delta under-represents real change. The comment acknowledges the trade-off, but the surface text reads "vs last week" without disclosing the frozen pillar.

**Fix**: Either compute a real 7-days-prior `bpInTargetPct` (re-pair sys+dia rows up to `prevUntil`) or relabel the delta as "vs last week (BP held constant)" / show the per-component delta breakdown so the user knows where the move came from.

### CR-MED-06 — `WeeklyReportView` early-returns the loading spinner when advisor is loading, even after the report is cached
**File**: `src/components/insights/weekly-report-view.tsx:85-94`

**What**: `if (authLoading || advisor.isLoading) return <Loader2 />`. `useInsightsAdvisorQuery` returns `isLoading: true` only on first mount; subsequent navigations hit the cached payload and `isLoading` is false from the first render. Edge case: a hard reload of `/insights/report/[week]` with no cache will spin even when the cached payload would arrive within ~50ms. Fine for UX, but the spinner blocks the auto-print effect: `if (advisor.isLoading) return` at line 73 means `?print=1` deep-links from the hero banner won't fire `window.print()` until after the cache hydrates — and the 300 ms timer is reset on every rerender of that effect's deps, which can be flaky.

**Fix**: Once `matchedReport` is non-null, fire the print timer once and gate it on a ref so a second-render isLoading flip doesn't restart it.

### CR-MED-07 — `<TrendsRow>` accepts an optional `confidence` prop but the parent never passes it
**File**: `src/components/insights/trends-row.tsx:71-75` + `src/app/insights/page.tsx:983-985`

**What**: The Trends row exposes a `confidence?: { bp?: …, weight?: …, mood?: … }` prop that the underlying `<TrendAnnotation>` renders as a chip. The page only passes `annotations`. Either the wiring was deferred (the comment mentions "from a backing correlation gives us one") and is a TODO, or the prop is dead surface area. Tests for `<TrendAnnotation>` cover the chip but no test threads the data through `<TrendsRow>`.

**Fix**: Either wire the `analytics.correlations` confidence bands into the page's `<TrendsRow>` invocation (BP chart ↔ bp-compliance card's confidence band, etc.), or drop the prop until B3.x lands the wiring.

### CR-MED-08 — Coach `provenanceFromJson` accepts an unsafe `windows` filter cast
**File**: `src/lib/ai/coach/persistence.ts:78-87`

**What**: The decoder filters `parsed.windows` for typeof string then casts to the strict union `ReadonlyArray<…>`. A poisoned row (e.g. legacy migration from a forked setup) could surface a "potato" window string that the UI's `WINDOW_KEYS` lookup then returns `undefined` from, rendering a chip with `t(undefined)` (which surfaces as the literal string `"undefined"`). Same pattern for metrics.

**Fix**: Validate against the `WINDOW_KEYS` allow-list (e.g. `["last7days","last30days","last90days","allTime"]`) before adding to the array. The set already exists in `source-chips.tsx` — extract to a shared constant.

### CR-MED-09 — `bpStoryboardAnnotations` resolves color via a string lookup that silently falls back to purple
**File**: `src/app/insights/page.tsx:915-935`

**What**: `STORYBOARD_COLOR_BY_CATEGORY[entry.category] ?? "var(--dracula-purple)"` — when the AI emits a category outside the four-element schema enum, the fallback paints purple, which is also one of the canonical colours. So the UI silently surfaces a wrong category as a valid one. The schema's `superRefine` should catch this at parse time, but the schema is `.passthrough()` and the page reads `advisor.payload.insights.storyboardAnnotations` raw, not via the validated `storyboardAnnotationsSchema`.

**Fix**: Run the page-level read through `storyboardAnnotationsSchema.safeParse` (mirroring how `useInsightsAdvisorQuery` does for `dailyBriefing` + `trendAnnotations`) so a bad category fails closed instead of misclassifying.

## LOW

### CR-LOW-01 — `<HeroStrip>` greeting bucket calls `now ?? new Date()` on every render, not cached
**File**: `src/components/insights/hero-strip.tsx:163`

**What**: A new `Date` per render. The bucketed key is stable across the hour, but a chatty parent that re-renders the hero on every TanStack Query tick still allocates. Tiny — call it polish.

**Fix**: `useMemo(() => resolveGreetingKey(now ?? new Date()), [now])` so SSR + client first paint match.

### CR-LOW-02 — `<HeroStrip>` `formatRelativeTime` reads `Date.now()` per render
**File**: `src/components/insights/hero-strip.tsx:138-148` and `daily-briefing.tsx:259-273`

**What**: Same helper duplicated across two files; same `Date.now()` per render → minor SSR mismatch risk if the timestamp lands within a few ms of a bucket boundary. Both files acknowledge the duplication via comments.

**Fix**: Extract to `@/lib/insights/relative-time.ts` and reuse.

### CR-LOW-03 — `Sheet` has nested `<Sheet>` children for the mobile rail trays
**File**: `src/components/insights/coach-panel/coach-drawer.tsx:131-275`

**What**: Two `<Sheet>` portals nested inside a third `<Sheet>` portal. Radix supports it, but the dom focus trap on the outer drawer + inner tray sheets can briefly fight when both open. Not observed yet; flag for B5/v1.4.21 polish.

**Fix**: Promote the trays to siblings of the outer sheet (mount alongside, not inside). Optional.

### CR-LOW-04 — `summariseTitle` ellipsis cut at TITLE_MAX-1 can land mid-multibyte sequence
**File**: `src/lib/ai/coach/persistence.ts:34-45`

**What**: `collapsed.slice(0, 79)` operates on UTF-16 code units, not grapheme clusters. A user message ending at byte 78 mid-emoji (e.g. "🩺" is two code units) gets a half-character on disk that may render as "?" in the rail.

**Fix**: Spread to an array first (`[...collapsed]`) so the slice is grapheme-aware. The unit test covers the `[...out].length` length-cap but not multibyte content.

### CR-LOW-05 — `bpInTargetRate` for the "previous" snapshot is held constant, but the test never asserts the delta is reasonable
**File**: `src/lib/analytics/__tests__/health-score.test.ts` + the route

**What**: The compute path holds BP rate constant for the previous snapshot; no test exercises a scenario where weight + mood + compliance all shift but BP doesn't, asserting that the delta reflects only the moving pillars. Coverage gap.

**Fix**: Add a test that holds bpInTargetRate constant across both snapshots and verifies delta reflects only weight/mood/compliance moves.

### CR-LOW-06 — `streamRefusal` persists the user message + refusal but bypasses `enforceBudget` accounting
**File**: `src/app/api/insights/chat/route.ts:347-404`

**What**: Refusal path runs the `enforceBudget` check at the top of `handleChatRequest` (line 149) but never writes anything to the `CoachUsage` ledger. A determined attacker can send 1000 prompt-injection messages a day and burn DB writes (one user-row + one assistant-row each) without the budget meter ticking.

**Fix**: Either bump `messageCount` (with `tokens: 0`) for refusals so the surface meter is honest, or rate-limit `streamRefusal` separately. The DB-write cost is small but the floor is non-zero.

## Praise (≤3 bullets)

1. **Conservative phrasing baked into the lib + tests.** `correlations.ts` has the "never causes Y" convention enforced by a unit test (`expect(html).not.toMatch(/causes?/i)`) — the kind of guardrail that survives the next refactor. Same convention shows up in the Coach refusal copy and the prompt's GROUND RULES 7–11.
2. **Coach security posture is the strongest in the repo.** AES-GCM at rest with key rotation, label-only provenance (no PII in the `metricSourceJson` column), HMAC-keyed token storage already in place from v1.4 marathon, 404-not-403 ownership boundary tested both for `GET /[id]` and the chat POST, prompt-injection regex bank that catches both English and German variants, per-user daily token budget with NaN/negative clamping. Maintaining this posture across the next iteration is worth explicit attention.
3. **`parseSseChunk` is pure + exhaustively tested.** Byte-by-byte interleaving, partial-frame buffer carry, malformed-frame skip, no-`data:` prefix tolerance — all covered without a network. The hook around it stays small as a result.
