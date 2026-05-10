# v1.4.17 — `.replace()` audit

Triggered by Marc's production /insights crash on 2026-05-10:

```
TypeError: Cannot read properties of undefined (reading 'replace')
  at stripChartTokens(insight.summary)
  at InsightAdvisorCard
```

## Root cause (the actual bug)

- **Surface**: `<InsightAdvisorCard>` consuming a legacy v1.4.14 cached
  payload (`{changed, stable, drivers, nextSteps, confidence,
  limitations}` shape — no `summary`, no `recommendations[]`, no
  `findings[]`).
- **Crash site**: `src/lib/insights/chart-tokens.ts:61`,
  `text.replace(TOKEN_REGEX, "")` with `text === undefined`.
- **Caller**: `src/components/insights/insight-advisor-card.tsx:511`,
  `<p>{stripChartTokens(insight.summary)}</p>`.
- **Why the legacy-payload guard didn't fire**:
  `isLegacyInsightPayload()` only flagged blobs whose `recommendations[]`
  contained string-recs or recs missing rationale. Marc's blob has no
  `recommendations` field at all, so the guard returned `false` and the
  rich card tried to render the v1.4.14 shape.
- **Why `safeParse` didn't catch it earlier**: the `/api/insights/generate`
  route does `validated.success ? validated.data : parsed` — when
  validation fails, the raw blob falls through unchanged. So a v1.4.14
  cache hit reaches the UI as-is.

## Audit scope

`git grep -nE '\.replace\(' src/` returned 82 hits. Categories:

### Safe (string-typed input or runtime-string)
- All `t(...).replace("{name}", value)` patterns (i18n always returns
  string).
- `String.toISOString().replace(...)`, `String.toLowerCase().replace(...)`,
  Array `.join().replace(...)`.
- `process.env.X ?? DEFAULT.replace(...)` (default is a string literal).
- Server-side `.replace()` on database string columns (`notNull`).
- Senders/redaction (`message.replace(...)`) — type-asserted upstream as
  required string fields in Zod.

### Already-guarded
- `health-chart.tsx:1014–1017` — chained `?.startsWith` short-circuits
  before the unguarded `.replace`.
- `health-chart.tsx:1261, 1273` — operates on `t(...)` result (always
  string).

### Found + fixed inline (this hotfix)
1. **`src/lib/insights/chart-tokens.ts`** — `stripChartTokens(text)` and
   `parseChartTokens(text)` accepted `string` only. Legacy payloads
   delivering `undefined` crashed `text.replace(...)` / `text.match(...)`.
   Fix: type widened to `string | null | undefined`, non-string returns
   empty string / empty array. **This is THE production bug.**

2. **`src/components/insights/insight-advisor-card.tsx`** — added an
   "isUnrenderable" short-circuit (`typeof insight.summary !== "string"
   || !Array.isArray(insight.findings) || !Array.isArray(insight
   .recommendations)`) before the rich-card render path, so the legacy
   blob hits a self-contained legacy-payload card with the regenerate
   CTA instead of trying to call `.replace()` on undefined fields.
   Belt-and-suspenders alongside the `legacyPayload` flag from the API.

3. **`src/lib/ai/legacy-payload.ts`** — `isLegacyInsightPayload()` now
   also detects the v1.4.14 pre-strict shape (no `summary` AND no
   `recommendations[]`). Previously it returned `false` for that shape,
   so the API surfaced `legacyPayload: false` to the UI and the rich
   card tried to render a non-renderable blob.

### Not fixed (out of scope, deferred)
- None. All hits classified as safe or fixed.

## Verification

- `pnpm test --run src/lib/insights/__tests__/chart-tokens.test.ts
  src/lib/ai/__tests__/legacy-payload-detection.test.ts
  src/components/insights/__tests__/insight-advisor-card.test.tsx` —
  39/39 green.
- The new test reproducing Marc's exact crash scenario (`<InsightAdvisorCard>`
  with the v1.4.14 `{changed, stable, ...}` blob) was RED before the
  fix, GREEN after.

## Severity

| Class | Count |
|---|---|
| Crash-on-undefined call sites | 1 (the production bug) |
| Already-guarded but worth strengthening | 0 (no pattern matches) |
| Non-string runtime risk in UI consumers | 0 after this hotfix |

The production crash was the only real instance. The audit confirms no
analogous time-bombs in other UI consumers.
