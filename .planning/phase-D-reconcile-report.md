# Phase D — Reconcile report (v1.4.18)

Date: 2026-05-10
Scope: act on the 6 reviewer briefs (code-review, security, design,
senior-dev, simplify, Product-Lead). Apply the 1 CRITICAL,
land HIGH where scope allows, run the simplify-yes batch, defer
the rest. Verify all gates green before tag.

## CRITICAL — status: FIXED

**C1 — Hidden-achievement trigger leakage in API response.**
The opaque-card UI was correct, but the JSON wire shape leaked
`metric`, `titleKey`, `descriptionKey`, `icon`, `target`,
`progressPercent`, plus the hidden-only metric counters. A user with
DevTools open could read the trigger semantics for every locked
Easter-egg. The iOS branch was strictly worse — server-side
resolved the i18n keys to plain text.

Commit `545f44c` — `fix(achievements): redact hidden-locked entries
from API response`. Adds `redactIfHiddenLocked()` and
`redactHiddenMetrics()` helpers in
`src/app/api/gamification/achievements/route.ts`. Hidden+locked
entries project to a sentinel shape (`achievements.hiddenCard.title`
key, `HelpCircle` icon, `metric: "totalTakenIntakes"`, target/current
0). Hidden-only metric counters (`nightOwlCount`, `earlyBirdCount`,
`leapDayCount`, `doctorPdfCount`, `localeFlipCount`) are dropped from
the `metrics` block unless the matching achievement is unlocked. The
iOS branch reuses the same redacted view.

5 new tests in
`src/app/api/gamification/achievements/__tests__/hidden-redaction.test.ts`
guard the wire shape. Existing 53 gamification tests stay green.

## HIGH triage

| Finding | Source | Fix / Defer | Commit |
|---|---|---|---|
| H1 — chart-overlay-prefs R-M-W race | code-review | FIXED | `cf75579` |
| H2 — `useChartOverlayPrefs(chartKey ?? "bp")` waste | code-review | FIXED via simplify F2 | `720e6c8` |
| H3 — bug-buddy shared metric leak | code-review | AUTO-RESOLVED by C1 | `545f44c` |
| H4 — mood-window doc/code mismatch | code-review | FIXED (doc clarified) | `c6e3ac6` |
| H5 — consistentMonthCount unbounded | code-review | FIXED (capped at 1) | `c6e3ac6` |
| HIGH-1 — same as C1 | security | AUTO-RESOLVED by C1 | `545f44c` |
| HIGH-2 — i18n bundle leak | security | DEFERRED to v1.4.19 | bundle-strip needs build hook |
| H1 design — mood `chartKey="mood"` default | design | FIXED | `fbf14fc` |
| H2 design — cog 28x28 to 44x44 | design | FIXED | `194ec2f` |
| H3 design — mood-chart header `flex-wrap` | design | FIXED | `fbf14fc` |

8 of 10 HIGH fixed inline. 1 deferred (HIGH-2 security — i18n
bundle architectural change, doesn't fit reconcile scope). 1
auto-resolved (HIGH-1 security = C1; H3 code = subsumed by C1).

## Simplify-yes (7/7 applied)

Combined commit `720e6c8` — `refactor(v1.4.18): apply simplify-review
safe suggestions`:

- **F1** — Drop duplicate `ChartOverlayPrefsValue` type + DEFAULT in
  `chart-overlay-controls`; re-export the canonical pair from
  `dashboard-layout`. Test imports updated.
- **F2** — `useChartOverlayPrefs(chartKey: ChartOverlayKey | null |
  undefined)` short-circuits when no key is supplied.
  `health-chart` drops the three discard-the-result ternaries.
- **F3** — `/api/analytics` no longer pair-and-counts BP twice; the
  windowed helper produces both the headline and the sub-values.
- **F4** — Drop the redundant `moodEntries.map(...)` reshape.
- **F5** — Merge the five hidden-metric defensive cases into the
  no-precondition block of `isEarnable`.
- **F6** — Delete the deprecated `getAchievementCategory` wrapper
  (zero callers).
- **F7** — Strip six "v1.4.18 gradient removed" what-comments.

No reverts; all simplify changes shipped.

## Final verification

```
pnpm typecheck         0 errors
pnpm lint              0 errors / 12 baseline warnings
pnpm format:check      All matched files use Prettier code style!
pnpm test --run        197 files / 1605 tests passing
pnpm test:integration  18 files / 66 tests passing
```

Format sweep landed as a separate commit (`3048dd6`) — 72 files,
pre-existing drift accumulated across v1.4.x. No behaviour change.

## Pointers

- **v1.4.19 backlog**: `.planning/v1419-backlog.md` — security
  HIGH-2 + 5 MEDs (code) + 4 MEDs (design) + 5 LOWs.
- **v1.5 backlog**: `.planning/v15-backlog.md` — updated with the
  v1.4.18 Product-Lead review's C.12-C.16 (per-user UI prefs as a
  platform pattern, achievement engine as next-best-action,
  hidden pattern as feature-discovery, engagement loop, shell
  layout audit).
- **Product-Lead strategic plan**:
  `.planning/phase-D-v1418-product-lead-review.md` — the v1.5
  backbone. Lift section C candidates + section D follow-ons +
  section E watchlist into the v1.5 milestone planning doc.

## Commits this session

- `545f44c fix(achievements): redact hidden-locked entries from API response`
- `720e6c8 refactor(v1.4.18): apply simplify-review safe suggestions`
- `fbf14fc fix(mood-chart): make chartKey opt-in and don't leak overlay state across pages`
- `194ec2f fix(chart-overlay-controls): bump cog to 44x44 tap target`
- `cf75579 fix(dashboard): wrap chart-overlay-prefs PUT in Serializable transaction`
- `c6e3ac6 fix(achievements): cap consistentMonthCount and clarify mood-improvement window`
- `3048dd6 style(prettier): sweep formatting across the tree`
