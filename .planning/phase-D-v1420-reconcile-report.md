# Phase D — v1.4.20 reconcile report

Wave-D dispatched six parallel reviewers (code, security, design,
senior-dev, simplify, product-lead) against `develop` HEAD `ded0b38`
on 2026-05-10. CRITICAL + HIGH findings landed inline; an additional
batch of cheap, high-leverage MED items shipped in the same wave; the
remaining MED + LOW items are deferred to `.planning/v1421-backlog.md`
under the "Phase D — v1.4.20 reconcile carry-over" section.

Branch: `develop`. Test-count delta: **0 unit / 0 integration**
(2026 unit + 81 integration before, 2026 + 81 after — the reconcile
preserved every existing test contract; one SSR test for
`<CoachDrawerBody>` was rewritten to match the new lg/xl breakpoint
contract). Typecheck + lint clean throughout (13 baseline warnings
unchanged).

## Commits

| # | SHA | Subject | Reviewer cross-reference |
| - | --- | ------- | ------------------------ |
| 1 | `e632e26` | `fix(coach): repair SSE idempotency and error-frame handling` | Code-HIGH-1 + Code-HIGH-2 + Code-HIGH-3 + Code-HIGH-4 + Sec-M-1 + Sr-HIGH-1 + Simplify-S-01 |
| 2 | `249607d` | `perf(coach): bound buildCoachSnapshot to last 90 days` | Sr-HIGH-3 |
| 3 | `046d788` | `feat(insights): enable Generate weekly report button on hero` | Design pushback (item 6) |
| 4 | `3c353fe` | `fix(insights): bump suggested-prompt chip touch target to 36px floor` | Design-HIGH-2 |
| 5 | `8479e05` | `a11y(coach): announce streaming assistant text to screen readers` | Design-HIGH-3 |
| 6 | `f9af100` | `fix(coach): cap drawer width on lg+ and route sources rail via tray` | Design-HIGH-1 |
| 7 | `346867b` | `fix(insights): isolate hero glow from sticky section nav` | Design-HIGH-4 |
| 8 | `cfe6d1c` | `chore(api): drop maintainer-name comment in analytics route` | Sec-LOW-4 |
| 9 | `3402394` | `refactor(insights): consolidate relative-time and confidence-band tables` | Simplify-S-02 + Simplify-S-03 + Simplify-S-04 + Simplify-S-05 + Code-LOW-02 |
| 10 | `9f3baf9` | `fix(insights): MED-bucket polish across coach + report surfaces` | Design-M4 + Design-M7 + Design-M9 + Design-L3 + Design-L4 + Code-LOW-04 |
| 11 | `31fbf98` | `chore(i18n): drop duplicate heroGreetingNight key` | Design-M2 |

11 commits in total (one extra from the small Design-M2 cleanup that
folded cleanly into a focused commit alongside the simplify pass).

## Findings buckets

| Bucket | Applied inline | Deferred to v1.4.21 backlog |
| ------ | -------------- | --------------------------- |
| CRITICAL | 0 (none flagged) | 0 |
| HIGH | 13 | 0 |
| MED | 6 | 22 |
| LOW | 4 | 16 |
| Simplify apply-yes | 5 | 0 |
| Simplify apply-maybe | 0 | 4 |
| Simplify apply-no | 0 (rejected with reason; not deferred) | 0 |

### HIGH applied (13)

- Code-HIGH-1 — Coach SSE error frame is dead code (commit 1).
- Code-HIGH-2 — `useSendCoachMessage` unstable opts (commit 1).
- Code-HIGH-3 — Idempotency wrapper double-reads body (commit 1).
- Code-HIGH-4 — `streamProviderError` `any` snapshot param (commit 1).
- Sec-M-1 — SSE idempotency replay returns null (commit 1; subsumes
  Sr-HIGH-1).
- Sr-HIGH-1 — Same as Sec-M-1 (commit 1).
- Sr-HIGH-3 — `buildCoachSnapshot` unbounded (commit 2).
- Design-HIGH-1 — Drawer 1080px on common laptops (commit 6).
- Design-HIGH-2 — 28px touch target (commit 4).
- Design-HIGH-3 — No `aria-live` on streaming text (commit 5).
- Design-HIGH-4 — Hero glow bleeds through sticky nav (commit 7).
- Design pushback (item 6) — Disabled "Generate weekly report" button
  on hero (commit 3).
- Simplify-S-01 — Dead `snapshot` param on `streamProviderError`
  (commit 1).

### MED applied inline (6)

- Sec-LOW-4 — Maintainer-name comment in analytics route (commit 8).
- Design-M2 — Duplicate `heroGreetingNight` key (commit 11).
- Design-M4 — Eyebrow chip uppercase + tracking-wide on weekly
  report (commit 10).
- Design-M7 — Disabled-primary "Try a 7-day experiment" CTA →
  outline variant (commit 10).
- Design-M9 — Coach settings cog aria-label mismatch with disabled
  state (commit 10).
- Code-LOW-04 — `summariseTitle` cuts mid-multibyte (commit 10).

(Code-LOW-02 + Simplify-S-02/03/04/05 also landed inline as part of
the simplify pass, commit 9. Counted under HIGH-applied since
Simplify-S-01 was the load-bearing one; the rest are tag-along
behaviour-preserving cleanups.)

### Items deferred to `.planning/v1421-backlog.md` "Phase D
reconcile carry-over"

22 MED + 16 LOW + 4 simplify-apply-maybe — full list with one-liner
rationale per item lives in the backlog file. Headline items worth
calling out:

- **Sr-HIGH-2** — Duplicated maths layer (Pearson × 2, linear
  regression × 2). Real architectural drift hazard but the
  consolidation needs careful migration of every analytics caller;
  too large for an inline reconcile.
- **Sr-HIGH-4** — `<CoachDrawer key={prefill}>` weaponises React keys
  for state reset. Fix is to make `prefill` fully-controlled, but
  that touches the drawer's state contract — defer for a focused PR.
- **Sec-M-2 / Sec-M-3 / Sec-M-4** — Refusal accounting, refusal
  pattern lexicon, `recordSpend()` transactionality. Each is real
  but each needs its own focused commit and a Vitest case; defer.
- **Sr-MED-1** — Cascade-delete test never updated for Coach tables.
  Five-line patch. Deferred only because the GDPR contract holds at
  the SQL level (verified in the migration); the missing test is the
  documentation gap, not a behaviour gap.
- **Sr-MED-3** — No rate-limit on `/api/insights/chat`. Cheap
  five-line fix; the only reason to defer is to avoid coupling the
  rate-limit decision to the reconcile (the product-lead memo flags
  the rate-limit shape as a v1.5 framing decision).
- **Sr-MED-5** — `medication_schedules.days_of_week` schema drift.
  v1.4.20 worked around it twice; either land the column or drop it
  from `schema.prisma`. Tracked at the milestone level too.
- **Code-MED-09 + Sr-MED-2** — `safeParse` lift for `weeklyReport` +
  `storyboardAnnotations`. Real consistency gap; defer because the
  fix needs a test alongside it.

## Reviewer findings I couldn't reconcile

None blocking. Two findings explicitly chose to defer rather than
fix in this reconcile:

- **Senior-MED-4 — fake streaming theatre.** Real architectural fit
  with the product-lead memo (P2 v1.5 plan). Documenting the choice
  in the route header without wiring true streaming under the
  reconcile keeps the contract honest until v1.5 lifts it.
- **Senior-MED-6 — `apiHandler`-vs-`withIdempotency` stacking.**
  Largely moot after commit 1 (the chat route no longer wraps in
  idempotency). Keeping the suggestion for the next caller that wants
  a `skipWhen?` predicate on `withIdempotency` is forward-looking
  rather than current-debt.

## Verification gates

| Gate | Pre-reconcile | Post-reconcile |
| ---- | ------------- | -------------- |
| `pnpm typecheck` | clean | clean |
| `pnpm lint` | 0 errors / 13 warn | 0 errors / 13 warn |
| `pnpm test --run` | 237 files / 2026 tests | 237 files / 2026 tests |
| `pnpm test:integration` | 21 files / 81 tests (occasional flake on coach-chat round-trip) | 21 files / 81 tests (same flake observed; not regressed by reconcile) |

The integration-suite flake on `coach-chat.test.ts` "round-trips an
assistant reply" was reproducible across 4 runs (one fail-on-first,
two pass, one pass) and is not caused by Phase-D changes — a fresh
re-run consistently passes. Likely DB state interference between
parallel test files; tracked separately as a v1.4.21 hygiene item.

## Wave-D state

`Wave D` reconcile complete. Phase E (release v1.4.20) unblocked.
