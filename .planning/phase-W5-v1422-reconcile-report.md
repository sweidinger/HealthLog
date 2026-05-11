# Wave 5 reconcile — v1.4.22

Branch: `develop` (10 reconcile commits ahead of `363e73c`).
Date: 2026-05-10.
Inputs: six W5 reviews + product-lead strategic memo.

## Summary

- 0 CRITICAL findings across all reviews.
- 7 HIGH findings — all applied inline.
- ~6 MEDs applied inline (judgment-pick high-leverage).
- Remaining MED + LOW deferred to `.planning/v1422-backlog.md`.

## Commits

| #   | SHA           | Title                                                                                   | Cross-ref                                                     |
| --- | ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | `75ccc01`     | fix(coach): graceful fallback when sentinel-only output strips empty                    | Code-H1                                                       |
| 2   | `ef597bf`     | fix(insights): align BD-Zielbereich delta math with comparison window                   | Code-H2                                                       |
| 3   | `b1ce6eb`     | refactor(auth): fold onboarding-cookie write into createSession + destroySession        | Sr-H1                                                         |
| 4   | `2075d39`     | refactor(api): extract createSseStream helper from chat route                           | Sr-H2                                                         |
| 5   | `a2e24b1`     | a11y(insights): polish sticky section nav (aria-current, focus, motion-reduce)          | Design-H1, Design-H3, Code-MED-4, Design-LOW-4                |
| 6   | `651a529`     | fix(insights): collapse BP tile to single secondary row at <sm                          | Design-H2                                                     |
| 7   | `65a8b5a`     | fix(coach): pin medical disclaimer at bottom of message thread                          | Design-H3, Design-M4                                          |
| 8   | `1631d80`     | refactor: simplify-pass apply-yes cleanup                                               | S-01..S-05                                                    |
| 9   | `6c0c69c`     | fix: MED-cluster — SameSite=Strict, exact-match PUBLIC_PATHS, Berlin tz, streaming race | Sec-MED-1, Sec-MED-2, Code-MED-2, Code-MED-3 (×2), Code-LOW-5 |
| 10  | _this commit_ | docs(planning): record Wave 5 reconcile + v1.4.22 backlog                               | meta                                                          |

## Findings by bucket

### HIGH (7 / 7 applied)

- **Code-H1** ✅ sentinel-only output no longer leaks `---KEYVALUES---` markers. New integration test covers the empty-prose-after-strip branch.
- **Code-H2** ✅ BD-Zielbereich tile compareDelta now matches caption: subtracts `bpInTargetPctPriorMonth` / `bpInTargetPctPriorYear` instead of `bpInTargetPctAllTime`. Two new bp-in-target unit tests + two insights-polish guards.
- **Sr-H1** ✅ `createSession` requires `onboardingPending` parameter; cookie-write fan-out reduced to one site. Three new auth-flow integration tests pin the contract.
- **Sr-H2** ✅ `createSseStream` extracted to `src/lib/sse/create-stream.ts`. Three unit tests pin sync, async, and throw paths.
- **Design-H1** ✅ section nav `aria-current`, `focus-visible` ring, `motion-reduce` gate, `bg-background/95 backdrop-blur`, `-mx-` removed, scrollbar hidden, observer ratio-sorted, `scroll-mt-28` → `scroll-mt-16`.
- **Design-H2** ✅ BP tile `<sm` collapses to a single combined "All-time X% · Δ Y last month" secondary row; `>=sm` keeps the full layout.
- **Design-H3** ✅ medical disclaimer pinned at bottom of message thread (always visible regardless of viewport); rail footer kept for desktop redundancy.

### MED (applied)

- **Sec-MED-1** ✅ `hl_onboarding` cookie `SameSite=Strict`.
- **Sec-MED-2** ✅ `/onboarding` exact-match + subroute guard.
- **Code-MED-2** ✅ dead i18n keys (`coach.settings`, `coach.settingsTooltip`) dropped.
- **Code-MED-3 (Berlin tz)** ✅ `berlinDayKey()` lifted to `src/lib/analytics/berlin-day.ts`; targets sparkline + analytics route share the helper. Four new unit tests for DST + UTC-midnight edge cases.
- **Code-MED-3 (streaming race)** ✅ 150 ms grace window on message-thread suppresses the persisted twin while the streaming bubble is still in flight.
- **Code-MED-4** ✅ IntersectionObserver picks highest-intersection entry; folded into Design-H1 commit.
- **Code-LOW-5** ✅ `queryKeys.dashboardWidgets()` centralised; three call sites migrated.

### MED (deferred)

All other MEDs documented in `.planning/v1422-backlog.md` under "Wave 5 reconcile carry-over":

- Sr-M1..M5 (analytics-route unbounded findMany; targets-route 7-pass sparkline; targets-page render mutation; provenanceFromJson hand-rolled validation; sentinel parser malformed enum).
- Design-M1..M3, M5..M7 (coach evidence aria semantics; sparkline min-points threshold; severity badge eyebrow + i18n; row-fill heuristic; live-preview affordance; sparkline aria sentiment).
- Code-MED-1 already applied; Code-MED-2 already applied; Code-MED-3 already applied (×2); Code-MED-4 already applied.

### LOW (deferred)

All LOWs deferred to backlog: Code-LOW-1..LOW-4, Sec-LOW-1..LOW-4, Design-L1..L5, Sr-L1..L4.

### Simplify (5 / 5 apply-yes applied)

- **S-01..S-05** ✅ all five applied in single `refactor: simplify-pass apply-yes cleanup` commit (`1631d80`).
- **S-M1..S-M4** deferred (maybe-tier).
- **S-N1..S-N6** rejected (per simplify review).

## Test count delta

- Baseline (pre-W5 reconcile): 2097 unit tests across 243 files.
- Final (post-W5 reconcile): **2111 unit tests across 245 files** (+14 unit tests, +2 files).
- Integration tests: 81 → 84 (+3) per the new auth-flow + coach-chat + proxy entries; verified locally (`pnpm test:integration auth-flow` passes 6/6).

New test surfaces:

- `src/lib/sse/__tests__/create-stream.test.ts` (3 tests)
- `src/lib/analytics/__tests__/berlin-day.test.ts` (4 tests)
- `src/lib/analytics/__tests__/bp-in-target.test.ts` (3 new tests for priorMonth/priorYear/null windows)
- `src/app/__tests__/insights-polish.test.ts` (2 new guards for Code-H2)
- `src/__tests__/proxy-onboarding-redirect.test.ts` (2 new guards for Sec-MED-2)
- `tests/integration/coach-chat.test.ts` (1 new test for sentinel-only leak)
- `tests/integration/auth-flow.test.ts` (3 new tests for createSession/destroySession cookie contract)

## Verification gates run between commits

For every commit:

- `pnpm typecheck` (clean — 0 errors)
- `pnpm test --run` (passes after each change; final 2111/2111)
- `pnpm lint` (15 pre-existing warnings, 0 errors)

For HIGH 1 + HIGH 3 + Sec-MED-2 (per brief):

- `pnpm test:integration auth-flow` 6/6 passes
- `pnpm test --run src/__tests__/proxy-onboarding-redirect.test.ts` 9/9 passes

## Items the maintainer should weigh in on

1. **CSP `connect-src` for `https://chatgpt.com`** is gated to `/settings/ai/**` only (per existing proxy.ts comment). The Coach SSE route hits OpenAI/Anthropic via the provider runner, which runs server-side — no browser fetch — so this is correct. Calling out only because the W5 simplify review flagged proxy.ts as out-of-scope and the cookie attribute changed; verify the connect-src isn't accidentally re-broadened by a future MED-2 follow-up.

2. **Insights page split deferred to v1.5 P5** per the product-lead memo. The W5 senior-dev review's L3 (`InsightsSectionNav` extraction) is a natural sub-task at that point. Leaving the page at 1700+ LOC for one more cycle is the right call but worth a v1.4.23 reminder when the next polish PR opens.

3. **Sr-M5 sentinel parser malformed-enum** carries the highest signal-to-effort ratio of the deferred MEDs (4-state enum, ~30 LOC, tightens ops observability before iOS volume lands). Suggest pulling forward to v1.4.23 if room.

4. **The `/api/auth/me` resync write** stays as a fall-back per the original v1.4.22 C4 design. Sec-LOW-1 calls it out only as a "future cargo-cult" risk — not an actual bug. Optional one-line code comment about not growing the GET-side mutation. Filed in backlog as LOW.

## Anything I couldn't reconcile

- All 7 HIGH applied successfully. No unresolved blockers.
- The Code-LOW-2 colon-bearing label parser test was deferred (LOW + low-priority). The defensive contract is documented in the prompt few-shots; an explicit constraint comment in the prompt header is the cleanest fix when v1.4.23 next-touches the prompt.
