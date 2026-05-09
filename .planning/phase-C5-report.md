# Phase C5 — Empty-states audit + fixes

Status: done — 2026-05-09T21:55+02:00

Audit document: [`docs/audit/v1415-empty-states.md`](../docs/audit/v1415-empty-states.md)

## Summary

13 empty-state surfaces upgraded across the app. Every list / table /
tile a brand-new user can land on now mounts the shared
`<EmptyState>` primitive (`src/components/ui/empty-state.tsx`) with an
icon, localized title + description, and (where it makes sense) a
primary CTA so the user always has a one-click path forward.

The primitive itself was already on `main` from earlier in v1.4.15 —
only the sweep was needed. No new dependencies, no schema changes, no
API changes.

## Counts per area

- **Admin (6)**: `/admin/users`, `/admin/backups`,
  `/admin/login-overview`, `/admin/api-tokens`, `/admin/feedback`,
  `/admin` overview audit-preview.
- **Feature lists (4)**: `/measurements`, `/mood`, `/medications`,
  `/achievements`.
- **Insights (2)**: top-level no-data state, BMI section
  height-not-set fallback.
- **Dashboard (1)**: tile-strip + chart-row both empty.

## Commits (origin/main)

- `5510ed5` `docs(audit): v1.4.15 empty-states audit + i18n keys` —
  audit document at `docs/audit/v1415-empty-states.md`; 18 new EN+DE
  keys under `measurements/mood/medications/admin.section.users/
  admin.section.backups/admin.{loginEmpty,tokensEmpty}/admin.feedback/
  insights/dashboard`. Sibling-agent C1 AI files swept in by the
  shared-cwd race (per STATE.md pattern); files correct on `main`,
  message scope misleading.
- `0c20119` `feat(admin): empty states for users, backups,
  login-overview, api-tokens, feedback` — 6 admin sub-routes upgraded.
  Adds `user-management-empty.test.tsx` + `backups-section-empty.test.tsx`
  guarding primitive mount, localized strings, and CTA-presence
  semantics.
- `9a74f8e` `feat(lists): empty states for measurements, mood,
  medications, achievements` — only carried the new
  `measurement-list-empty.test.tsx` due to a sibling-cwd staging race;
  message-scope wider than diff.
- `1d65f3b` `feat(lists): empty states for measurements, mood,
  medications, achievements (impl)` — follow-up that lands the actual
  EmptyState wiring described in the previous commit's message.
- `65faf1d` `feat(insights,dashboard): empty states for first-run
  views` — `/insights` top-level + BMI height-not-set + dashboard
  fully-empty paths.

## Tests

- Unit: 1028 / 1028 passing (was 1005 before C5; +23 across the new
  empty-state tests + indirect i18n key resolution checks).
- Typecheck: pre-existing A4 `dashboard-layout.test.ts` errors only —
  no new errors introduced.
- Lint: 0 errors, 11 warnings (all pre-existing, none in C5 files).

## i18n footprint

18 new keys, EN + DE pairs, additive only. No deletions, no key
renames. C4 sweep can fold these into the parity guard without
refactoring.

## Cross-agent observations

The shared-cwd / shared-index commit race observed throughout the
v1.4.15 marathon (A2 / A4 / B-mobile / B1 / B2 / B3 / B4 / B5 / B6 /
C2) reproduced twice during this phase:

1. Commit `5510ed5` (intended: audit + i18n) inadvertently swept three
   sibling-agent (C1) AI files (`src/lib/ai/generate-insight.ts`,
   `schema.ts`, `__tests__/generate-insight.test.ts`) because they were
   untracked at commit time. The audit doc + i18n keys are correct;
   the AI files belong to C1 and are now on `main` under my message.
2. Commit `9a74f8e` was supposed to carry the four feature-list impl
   files plus the new test, but only the new test got staged — six
   modified files reverted from the index between `git add` and `git
   commit`. The follow-up commit `1d65f3b` lands the impl with an
   explicit message tying the two together.

Both patterns match STATE.md's documented "v1.4.16 should adopt
`superpowers:using-git-worktrees` per agent" recommendation. None of
the diffs on `main` are wrong — only the commit-message-to-diff
mapping drifts. C1's files are on `main` ahead of their commit; C5's
impl is split across two commits with a tying-back message.

## Verification commands run after each commit

```
pnpm test --run                          # 1028/1028 pass
pnpm typecheck                           # only pre-existing errors
pnpm lint                                # 0 errors
```

## What's intentionally NOT touched

- `src/lib/ai/`, `src/app/api/insights/generate/route.ts`,
  `src/lib/ai/prompts/` — owned by C1.
- `src/lib/withings/`, `src/lib/moodlog/`, `src/lib/notifications/` —
  owned by B2/B3 (already done).
- `messages/*.json` mass refactor — only additive new keys per scope.
  C4 will sweep for parity later.
- Inline correlation-card empty surfaces inside `/insights` (the
  `scatterData.length < 5` paths) — already use a tighter custom
  variant; refactor would be churn-only. Documented as deferred in
  the audit doc.

## Next phase touchpoints

- Phase D code-reviewer can validate the EmptyState adoption pattern
  is consistent (icon + title + description + CTA-where-appropriate).
- Phase D design review can verify the dashboard "fully empty" surface
  doesn't conflict with the GettingStartedChecklist's own self-gated
  rendering — both should not paint at the same time, but they live
  in different render branches.
- Phase E release notes: "Brand-new accounts now see helpful empty
  states across every list, table, and tile instead of blank
  rectangles."
