# Wave 5 — Code review (v1.4.22)

Branch: `develop` (24 commits ahead of `main`).
Scope: the W2 Insights polish (7 commits), W3 Coach polish (5 commits), and W4 surfaces+backlog (6 commits) sets. The five preserved e2e fix commits are not reviewed (test-only). Generated reports (`.planning/v1422-w1a-*.mjs`, `scripts/audit-a6*.mjs`) and the un-touched export untracked dirs are out of scope.

## Summary

- Files reviewed: ~30 (route + component + lib + i18n) plus the integration + unit specs that pin them.
- Findings: **0 CRITICAL · 2 HIGH · 4 MED · 5 LOW**.
- Overall quality: solid. The sentinel parser (`src/lib/ai/coach/keyvalues.ts`) is genuinely defence-in-depth — three independent caps (1 KB, 8 lines, per-line Zod), graceful degrade on missing close marker, prose untouched on no-sentinel, and a wide-event log on every malformed branch. The proxy onboarding redirect is correctly scoped, exempts API routes, and self-loop-protects `/onboarding`. The system-prompt rewrite is well-tested (134 lines of EN+DE assertions) and the few-shots match the W1b research output. The two HIGH findings are concentrated on edge cases the existing tests don't exercise: the chat route's `replyText` fallback can leak the raw `---KEYVALUES---` markers when a model emits a sentinel-only malformed reply, and the BD-Zielbereich tile's comparison delta uses the wrong baseline window (compares 30d vs all-time but labels it "vs. last month" / "vs. last year"). MED findings cover sparkline timezone drift, dead i18n keys, and a couple of missing test coverages.

## HIGH

### HIGH-1 — Raw `---KEYVALUES---` markers can leak into the streamed prose when the model returns a sentinel-only malformed reply

- File: `src/app/api/insights/chat/route.ts:274-275`
- What: the code is

  ```ts
  const sentinel = parseKeyValuesSentinel(rawReply);
  const replyText = sentinel.prose.trim() || rawReply;
  ```

  When the provider emits ONLY the sentinel block (no leading prose) AND the block is malformed (e.g. missing `---END---`, the parser still keeps any valid lines but flags `malformed = true`), `sentinel.prose === ""`, the trim is falsy, the `|| rawReply` fallback kicks in, and the raw response — including `"---KEYVALUES---"` and any partial body — is what gets `tokeniseForStreaming()`'d to the client AND persisted as `assistantMessage.content`.

- Why: the `|| rawReply` was meant to cover legit empty-prose cases (qualitative reply without any sentinel), but for those cases `parseKeyValuesSentinel()` returns `{ prose: rawReply, keyValues: [], malformed: false }` so the fallback never trips. The actual cases where `sentinel.prose` is empty AFTER parsing are exactly the cases where stripping happened — meaning the rawReply is unsafe to surface. The hardening comment `"the user never sees the raw sentinel"` (in `parseKeyValuesSentinel`'s docstring) is therefore voided in this edge case. No existing test exercises a sentinel-only model reply; the integration test at `tests/integration/coach-chat.test.ts:286` always includes prose.
- Fix: replace the fallback with an explicit handler that prefers `sentinel.prose.trim()` and falls back to a localised "Coach answered without context" message OR routes to `streamProviderError({ code: "coach.provider.empty" })` when the parser found a sentinel but no usable prose. Pseudocode:
  ```ts
  const replyText = sentinel.prose.trim();
  if (!replyText) return streamProviderError({ code: "coach.provider.empty" });
  ```
  Add a regression test: provider mock returns `"---KEYVALUES---\nfoo: bar"` (no close marker, no prose), assert the streamed body does not contain `"---KEYVALUES---"`.

### HIGH-2 — BD-Zielbereich tile's comparison delta math contradicts its caption label

- File: `src/app/page.tsx:838-841` (BP-target tile branch inside the `(() => { … })()` IIFE)
- What:
  ```ts
  const bpCompareDelta =
    compareBaseline === "none" || bp30 === null || bpAll === null
      ? null
      : Math.round((bp30 - bpAll) * 10) / 10;
  ```
  This computes `last-30-days-pct − all-time-pct` regardless of whether `compareBaseline` is `"lastMonth"` or `"lastYear"`. The `<TrendCard>` then renders a caption keyed on `compareBaseline` — `"comparison.captionLastMonth"` / `"comparison.captionLastYear"` — so the user reads a sentence like _"Δ −5.0 % vs. last month"_ whose numerator is actually the 30-day window MINUS the all-time average. Neither "last month" nor "last year" is what the math represents.
- Why: the W2 author left a comment `"the prior-period delta uses bpInTargetPctAllTime as the long-arc baseline"` (page.tsx:815) but didn't follow through to make the caption truthful. This is a `feedback_no_pii_in_user_facing.md`-adjacent honesty issue: the surface lies to the user about what the number means. Other tiles (weight, BP, pulse, mood, sleep, steps) compute the delta via `tileCompareDelta()` which reads `summary.avg30LastMonth` vs `summary.avg30` — a real period-aligned comparison. The BD-Zielbereich tile is the only one that diverges.
- Fix (two options, both acceptable):
  1. **Drop the comparison delta on the BD-tile** while the analytics route doesn't ship windowed prior-period in-target rates. Pass `compareDelta={null}` always; the comparison toggle then has no effect on this tile, which the user can detect by absence and which is honest.
  2. **Compute the right baseline.** Add `bpInTargetPctLastMonth` / `bpInTargetPctLastYear` to the analytics envelope (cheap re-pair against a windowed sys/dia slice over the prior month/year), then route the same `tileCompareDelta()`-style logic through.
  - Either way, write a unit test in `src/app/__tests__/insights-polish.test.ts` (the W2 spec home) asserting that when `compareBaseline === "lastMonth"`, the delta the tile receives is computed against a last-month baseline, NOT all-time.

## MED

### MED-1 — `sparklinePoints()` keys days by UTC, not Berlin

- File: `src/app/api/insights/targets/route.ts:199-216`
- What: the helper builds buckets keyed by `m.measuredAt.toISOString().slice(0, 10)` (a UTC `YYYY-MM-DD`), while the analytics route's `berlinDayKey()` (`src/app/api/analytics/route.ts:330-336`) uses Europe/Berlin parts. The CLAUDE.md timezone convention is "Europe/Berlin for display, UTC in database"; the sparkline is a display surface.
- Why: a reading taken at 23:30 Berlin time on a Tuesday lands in Wednesday's UTC bucket. For the target-card sparkline (30 daily means rendered as a 100×24 SVG path), the 1-day cross-DST drift is visually negligible — but it diverges from the rest of the analytics surface, and any future "match the day count to the calendar shown in the sidebar" feature will inherit the bug. Pure inconsistency cost; no current visual regression.
- Fix: lift `berlinDayKey()` into a shared helper (e.g. `src/lib/analytics/berlin-day.ts`) and call it from both routes. Add a unit test that pins a 23:30-Berlin reading on the last-Tuesday-of-October (DST boundary) to the correct Tuesday bucket.

### MED-2 — `coach.settings` / `coach.settingsTooltip` i18n keys are dead after W3 cog removal

- File: `messages/en.json:856-857` and `messages/de.json:856-857` (`insights.coach.settings`, `insights.coach.settingsTooltip`).
- What: W3 commit `b845cf5` (drawer polish) removed the settings cog from `coach-drawer.tsx`. The two i18n keys those buttons resolved against are still in both locale files. `grep` finds zero call sites in `src/`.
- Why: dead JSON noise; not a functional bug. The locale-integrity test (`src/lib/__tests__/i18n-locale-integrity.test.ts`) only validates parity between EN/DE, so dead keys present in BOTH locales pass. Per CLAUDE.md the convention is "keys missing in the active locale fall back to English; missing from both surfaces the raw key" — these are missing from neither, just from the source. They'll come back when the per-user prompt-tuning panel ships in v1.4.23, so the cleanup is optional, but if v1.4.23 picks a different key shape these stay as confusing legacy.
- Fix: either drop both keys with a one-liner JSON edit (since v1.4.23's tone-slider panel will likely want different copy anyway), or add a comment marker like `"_deprecated__settings": "Coach settings"` per the CLAUDE.md "deprecated until a hygiene PR removes them" pattern. Suggest the drop.

### MED-3 — `assistantMessage.content` persists the user-visible body, but `streaming.content` keeps streaming the same text — possible duplicate render race after slow refetch

- File: `src/components/insights/coach-panel/message-thread.tsx:66-71`
- What: the de-dup logic at lines 66-71 is

  ```ts
  const streamingPersisted =
    streaming?.messageId != null &&
    messages.some((m) => m.id === streaming.messageId);
  const streamingActive = !streamingPersisted && (...);
  ```

  This compares the streaming bubble's `messageId` (set from the SSE `done` frame) against the persisted history's `m.id`. The persisted message lands AFTER the TanStack-Query invalidate-then-refetch resolves. There's a short window between "SSE `done` fires" → "useMutation onDone calls invalidate" → "refetch resolves" where `streaming.messageId` is set but `messages` doesn't yet contain it.

- Why: in that window the user briefly sees TWO assistant bubbles with the same content (the streaming bubble + the just-arrived persisted bubble). The W3 author tested the steady-state ("hides the streaming bubble once its persisted twin lands by id"), but not the in-flight transition. On a slow connection this is a 200-500ms duplicate render. Not a hard bug — the steady-state self-corrects — but jarring on mobile.
- Fix: either pin both bubbles to the same React `key` derived from `messageId` so React reconciliation collapses them into one, OR clear `streaming.content` when `streaming.messageId` is set (the hook layer change). The first is cheaper.

### MED-4 — `InsightsSectionNav`'s IntersectionObserver may fire `setActiveId` for a section that's about to scroll out

- File: `src/app/insights/page.tsx:1729-1747`
- What: the observer callback iterates `entries` in observer-supplied order and unconditionally calls `setActiveId(entry.target.id)` for each `isIntersecting === true` entry. With three sections briefly visible during a scroll, the LAST iterated entry wins regardless of which is most prominent.
- Why: visually, this presents as the active-tab pill jumping to the wrong tab during a fast scroll past several sections. The `rootMargin: "-30% 0px -60% 0px"` window narrows the active band but doesn't eliminate concurrent-intersection cases. Apple Health's section nav picks the entry whose `intersectionRatio` is highest in the band; this implementation picks "whichever comes last in the observer's batch".
- Fix: filter to `entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]` and only setState when its `id` differs from the current `activeId`.

## LOW

### LOW-1 — `mood` chart in the trends-row hard-codes the mood title via `t("charts.mood")` and ignores `MoodChart`'s default

- File: `src/components/insights/trends-row.tsx:148`
- What: `<MoodChart title={t("charts.mood")} mini />` passes a title prop, but `<MoodChart>` already self-resolves a localised title when `title` is omitted. Two of three trend cards (BP, weight) explicitly pass titles too. Coupling tightens unnecessarily — a future title change on `<MoodChart>` won't propagate here.
- Fix: drop the `title` prop on all three callsites if the component self-titles, or accept the duplication as an explicit-over-implicit choice and add a brief comment.

### LOW-2 — `parseKeyValueLine` regex doesn't match a label that contains a colon

- File: `src/lib/ai/coach/keyvalues.ts:53` (`const colon = trimmed.indexOf(":");`)
- What: the parser uses the FIRST colon as the label/value boundary. A model emitting `"avg30 PR-rest: 64 [bpm]"` parses cleanly, but `"Mon 6 May, 7:30 reading: 142/88 [mmHg]"` becomes `label="Mon 6 May, 7"`, `value="30 reading: 142/88"`. The current prompt instructs `<= 40 char` labels and "day-pin" examples like `"Tue 6 May"` (no time-of-day), so the model is unlikely to emit such labels — but a future prompt rev that adds a time-of-day pin would silently break.
- Fix: add a parser test for a colon-bearing label as a regression pin, OR document the constraint in the prompt explicitly. The existing prompt `<example>` rows all avoid the case but the contract isn't stated.

### LOW-3 — Sentinel parse failure is logged with `kept` count but not the prompt-version-vs-malformed-cause breakdown

- File: `src/app/api/insights/chat/route.ts:284-291`
- What: when `sentinel.malformed === true`, the route logs `meta: { kept, promptVersion }`. It does NOT log WHY the block was malformed (`closing-marker-missing` vs `truncated-at-1KB` vs `zero-valid-rows`). Ops triaging a provider whose sentinel format has drifted would have to reproduce locally to learn which cap fired.
- Fix: extend `SentinelParseResult` with a `reason: "ok" | "no_close_marker" | "truncated" | "empty_block"` field and log it. The added field stays internal; no schema change needed.

### LOW-4 — `Sparkline`'s `Math.min(...points)` can blow stack on adversarial inputs

- File: `src/app/targets/page.tsx:272-273`
- What: `Math.min(...points)` and `Math.max(...points)` are spread-call patterns that can blow the JS engine's call-stack at ~10k arguments. The current API caps `points30d` at ~30 entries (one per Berlin day), so the practical risk is zero — but the API doesn't enforce that explicitly, and a future change to ship hourly buckets would land directly here.
- Fix: replace with a `for` loop or `points.reduce((acc, v) => …)`. One-liner; defence-in-depth, not a current bug.

### LOW-5 — `comparisonBaseline` query keys are duplicated across pages with the same string array

- Files: `src/app/page.tsx:202`, `src/app/insights/page.tsx:564`, `src/components/settings/dashboard-layout-section.tsx:57` — all three use `queryKey: ["user", "dashboardWidgets"]` as a literal.
- What: same key shape in three callsites; one typo turns into a silent cache miss + extra fetch. The repo already has `src/lib/query-keys.ts` for exactly this pattern (`queryKeys.analytics()`), and this key isn't centralised.
- Fix: add `dashboardWidgets: () => ["user", "dashboardWidgets"] as const` to `src/lib/query-keys.ts` and migrate the three callsites. Same query-key-collision discipline as the existing `queryKeys.analytics()` per `feedback_react_query_key_collision.md`.

## Praise

- The sentinel parser (`src/lib/ai/coach/keyvalues.ts`) is one of the cleanest parsers in the codebase: three orthogonal caps (1 KB byte, 8-line, per-line Zod), explicit `malformed` provenance, and an obvious-by-construction graceful-degrade path. The 18 unit tests cover the right shapes (truncation, close-marker missing, mixed-malformed-with-valid, empty input).
- Moving the onboarding redirect from `<AuthShell>` `useEffect` to `proxy.ts` is the right architectural call. The `hl_onboarding` cookie's "UX hint, not a security signal" framing is correctly stated in code comments AND enforced by the audit-trail behaviour (the real check stays server-side in `/api/onboarding/complete`). Seven proxy unit tests pin the contract including the API-route-passthrough invariant that would have been easy to overlook.
- The W2 i18n integrity test addition (`DE locale renders Health-Score component labels in German`) catches the exact "Mood" → "Mut" voice-to-text regression class. Pinning four specific German strings instead of "the value differs from English" is the more defensive shape — a future copy-paste of "Stimmung" → "Mood" still fails it.
