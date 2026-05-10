# v1.4.23 Wave 5 — hygiene (H1-H7) + STATE tick

Closes the seven hygiene items deferred from
`.planning/v1422-backlog.md`. Eight atomic commits; develop branch
clean, all unit + drift gates green.

## Commits

1. `58ae9bc` — `feat(coach): partial-malformed observability on
   sentinel parser` (H1)
2. `fa07748` — `perf(api): chunked BP aggregate replaces unbounded
   findMany` (H2)
3. `9413d29` — `refactor(coach): drawer prefill becomes a controlled
   prop` (H3)
4. `3f60c81` — `feat(coach): per-user prompt-tuning surface (settings
   cog returns)` (H4 — prisma + route + UI)
5. `0eda1de` — `chore(schema): deploy medication_schedules.days_of_week
   column` (H5)
6. `1faee95` — `fix(insights): tighter Pearson surfacing gate (n>=20)`
   (H6)
7. `05c7f14` — `feat(coach): per-message thumbs feedback + admin
   aggregate view` (H7 — schema + route + UI)
8. (this commit) — `docs(planning): record W5 hygiene wave + STATE
   tick`

## H5 decision

Deploy the column. `MedicationSchedule.daysOfWeek` is referenced by
nine source files across the form, card, intake list, reminder
dispatcher, and gamification path. Removing it would force a UI
rewrite of the recurrence picker and break existing test fixtures.
Migration `0039_medication_schedule_days_of_week` adds the column
nullable, default NULL. NULL means "daily" — `parseScheduleRecurrence(null)`
already returns the all-7-days set so existing rows get the correct
semantics without backfill.

## H7 admin view

Path: `/admin/coach-feedback`. Renders the Coach-only buckets sliced
by (promptVersion, tone, verbosity) with helpful / not-helpful / n /
helpful-rate columns. First useful question it answers in the
v1.4.23 first-week window: "Is the v1.4.22 prose rewrite landing
well, or did the warm tone overshoot?" If the helpful-rate for
PROMPT_VERSION 4.23.x drops below 50% within the first 100 ratings,
v1.4.24 walks the persona back.

## OpenAPI registry — additions

Three new routes registered:

- `GET /api/auth/me/coach-prefs` (H4)
- `PUT /api/auth/me/coach-prefs` (H4)
- `POST /api/insights/chat/messages/{id}/feedback` (H7)

Spec regenerates without drift; `pnpm openapi:check` passes.

## Test deltas

- Unit: 2191 → 2223 (+32)
- Integration: +2 new files (`coach-prefs.test.ts`,
  `coach-feedback.test.ts`) plus a 6 000-row chunk-boundary
  regression added to `bp-in-target.test.ts`

## Verification gates

- `pnpm typecheck` — clean across all 8 commits
- `pnpm lint` — 0 errors, 21 warnings (all pre-existing in
  unrelated files)
- `pnpm test --run` — 256 files / 2223 tests passing
- `pnpm openapi:check` — spec in sync

## Carry-overs

None — all seven hygiene items shipped.

## Notes for v1.5

- The Pearson surfacing-gate raise (n≥14 → n≥20) means some
  borderline correlation cards STOP rendering. If the v1.4.16 B5e
  feedback aggregator shows users miss those cards, drop in the
  rigorous incomplete-beta replacement in v1.4.24 (queued as the
  follow-up).
- The Coach settings cog opens a small surface today (4 controls).
  v1.4.24+ can iterate based on the H7 admin dashboard's first-week
  signal — the design review pushed back on per-message controls in
  v1.4.23, defer that decision to v1.5 P3.
- Per-user `coachPrefsJson` is read on every Coach turn — no caching
  layer to invalidate. The settings sheet writes the
  `["coach-prefs"]` query cache directly so the next reply honours
  the new defaults without a page reload.
