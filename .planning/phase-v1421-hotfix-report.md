# Phase v1.4.20.1 — hotfix report

Date: 2026-05-10 (post-v1.4.20 deploy).
Triggered by Marc's testing of the new Insights/Coach surface in
production. Five issues captured in
`feedback_v1420_post_deploy_bugs.md`; all six commits below land on
`develop` with no tag — the maintainer decides whether to ship as a
v1.4.20.1 hotfix or bundle into v1.4.21.

## Issue 1 — Daily Briefing regenerate produced nothing

**Diagnosis.** `/api/insights/generate` was still calling the legacy
`getInsightsSystemPrompt` from `src/lib/insights/prompt.ts`, which
returns the v1.4.5 `{changed, stable, drivers, …}` shape and never
asks the model for a `dailyBriefing`. The B1 phase shipped GROUND
RULE 8 (emit dailyBriefing when the snapshot has signal) on
`getStrictInsightsSystemPrompt` in
`src/lib/ai/prompts/insight-generator.ts`, but the route never
adopted it. Re-runs from the hero strip therefore stored a payload
with no briefing block and the `<DailyBriefing>` card painted its
empty state forever.

**Fix.** Switch the route to `getStrictInsightsSystemPrompt(locale)`.
The route's existing `validated.success ? validated.data : parsed`
fall-through and the strict schema's `passthrough()` mean the change
is back-compat for cached legacy blobs. Commit `7921ffc`.

## Issue 2 — Coach felt generic, couldn't answer day questions

**Diagnosis.** `buildCoachSnapshot` shipped only aggregated
statistics (mean, slope, SD, range, count) per metric. A turn that
asked "why was BP higher on Monday?" had no day-level rows and the
model fell back to apologetic aggregate-only phrasing — Marc's
actual reply was "from the snapshot I cannot isolate the specific
Monday because no day-specific individual values with weekday are
included." Two layers of fix needed: snapshot must carry the data;
prompt must tell the model to use it.

**Primary fix (commit `ed61b17`).** Extend `buildCoachSnapshot` to
fold in a `timeline.recent` block (one row per UTC day for the last
14 days, each tagged with weekday) and a `timeline.weekly` block
(ISO-week buckets covering days 15..N). Pair systolic + diastolic
into one BP row per day; drop half-measured days so the model never
fabricates a complement. Pull per-day medication adherence rows from
`MedicationIntakeEvent`. Add an optional `scope` field to
`coachChatRequestSchema` (sources + window) so a future picker can
narrow without breaking existing clients.

**Secondary fix (commit `2143377`).** Add a DAY-LEVEL READINGS
section to both EN and DE Coach system prompts: explain the timeline
shape; instruct the model to answer day-specific or weekday-specific
questions out of `timeline.recent` and to cite the actual reading
with date + weekday; tell the model to acknowledge missing days
plainly and offer the closest available day; let older weekday
questions fall back to `timeline.weekly`.

## Issue 3 — Duplicate assistant reply in display

**Diagnosis.** After SSE `done` the streaming hook keeps
`streaming.content` populated to support the in-flight render path,
then fires a TanStack invalidate that pulls the persisted assistant
message into `conversation.messages`. Until the next `send` reset
the message thread therefore rendered the assistant reply twice.
Marc noticed the duplicate cleared on drawer close + reopen — the
persisted state was correct, the bug was purely client-side render
overlap.

**Fix.** Suppress the streaming bubble at render time as soon as the
persisted twin lands. The match keys on `streaming.messageId`,
which the SSE `done` frame fills in once the row is on disk; mid-
stream the field is null so the in-flight bubble stays visible.
Commit `f07e35b`.

## Issue 4 — Settings cog vs Sheet close-X collision

**Diagnosis.** Radix Sheet paints its default close-X at absolute
top-4 right-4. The v1.4.20 drawer header parked the settings cog
inside the right-edge button cluster, so the close-X overlay
visually swallowed the cog — the icon still rendered but read as
unclickable.

**Fix.** Move the cog to the left side, immediately after the
gradient avatar, so the right edge is reserved for Radix's close-X
alone. Add `pr-12 / sm:pr-14` padding to the header so the New chat
button can never slide under the close-X on narrower viewports
either. Commit `ddb2914`.

## Issue 5 — Sources rail had no toggle UI

**Diagnosis.** The Sources rail listed BP / Weight / Pulse / Mood /
Compliance as a static legend. Marc wanted per-source checkboxes
(include/exclude) plus a window selector (last 7d / 30d / 90d /
all-time) feeding the next Coach turn.

**Fix (commit `08fd411`).** Wire the controls all the way down:
`<SourcesRail>` grows `scope` + `onScopeChange` props with real
checkboxes (36px touch target; 60% opacity when excluded) and a
`<Select>` for the window. `<CoachDrawer>` owns the scope state
(resets each mount per the v1.4.20.1 plan) and forwards picked
scope through `useSendCoachMessage` to the chat request body. The
payload only ships when the user has narrowed away from the all-
source last30days default — server can tell "no opinion" from
"intentionally narrow". `buildCoachSnapshot` already accepted the
optional `CoachScope` from the previous commit; it now flows end-
to-end. New i18n key `insights.coach.windowLabel` in EN+DE.

## Test count delta

- 2026 → 2036 unit tests (+10 net).
- 6 new tests in `src/lib/ai/coach/__tests__/snapshot.test.ts`
  covering empty input, day-level BP rows, scope.sources filter,
  scope.window narrowing, default scope, mood-only path.
- 2 new tests in
  `src/components/insights/coach-panel/__tests__/message-thread.test.tsx`
  pinning the streaming-bubble dedup behaviour (suppress when
  persisted twin lands; keep when still streaming).
- 2 new tests in
  `src/components/insights/coach-panel/__tests__/sources-rail.test.tsx`
  pinning the checkbox count + scope-driven active state.

Integration suite green; `tests/integration/coach-chat.test.ts` still
passes 5/5 with the route changes.

## Token-budget impact of the day-level snapshot

Aggregates-only snapshot before: ~760 bytes JSON ≈ 190 tokens.
Day-level snapshot after, full 5-source 30-day window: ~12 KB JSON
≈ 3000 tokens. Delta is roughly +2800 tokens per turn. The
`MAX_TOKENS_PER_USER_PER_DAY = 25_000` cap therefore drops a heavy
user from ~13 turns/day to ~8 turns/day. The new scope picker is
the relief valve: a single-source, last-7-days narrowed turn lands
around ~600-700 tokens. v1.4.21 should consider reducing the
`DAILY_TIMELINE_DAYS` constant from 14 → 10 if heavy users start
hitting the cap; usage data will tell.

## Dispatch recommendation

Ship as **v1.4.20.1 hotfix** rather than bundling into v1.4.21.
Reasoning:

- Issue 1 is a regression of the v1.4.20 headline feature — Daily
  Briefing was the centerpiece of the Insights redesign and it
  hasn't been working since the tag.
- Issue 3 is a render bug that makes every Coach interaction look
  broken to a first-time user.
- Issues 2, 4, 5 are quality-bar items that, taken together, fix the
  "Coach feels impersonal" perception that undercuts the AI-Insights-
  as-differentiator product principle.
- The diff is contained: 8 files touched across 6 commits, no
  schema migration, no new dependencies, no breaking API change
  (`scope` is additive optional). All 2036 unit tests + the
  coach-chat integration suite green.

The runtime risk of holding the fixes for v1.4.21 is that production
keeps shipping a broken Daily Briefing. A patch tag here is exactly
what the conservative-semver memory expects.

## What was not fixed

Nothing was deferred — all five issues have a working fix on
`develop`. One follow-up worth tracking in v1.4.21:

- The +2800 tokens/turn snapshot delta is at the upper end of what
  the 25k/day budget tolerates for power users. v1.4.21 should
  watch real usage and either trim `DAILY_TIMELINE_DAYS` from 14 to
  10, or add a "summarise-when-narrow" path that drops the
  `timeline.weekly` block when the window is `last7days`.
