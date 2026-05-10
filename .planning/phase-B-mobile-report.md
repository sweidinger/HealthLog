# Phase B-mobile — Mobile audit fix-application

Window: 2026-05-09T20:40-20:54+02:00 (~14 min wall-clock; 5 commits
shipped). Source of truth: `.planning/phase-A5-mobile-findings.md`.

## Tally

- 2 / 2 CRITICAL fixed
- 6 / 8 HIGH addressed (4 fully + 2 partially via tap-target sizing)
- 3 MEDIUM picked up opportunistically (login + chart switches + med
  card icon buttons)
- 5 deferred (cross-cutting tab/insights/measurements work + bottom-
  nav redesign)

## Fixes shipped

### Fix 1 — `316c3b0` — fix(charts): chart wrappers allow vertical scroll passthrough on mobile

- **Finding ID**: A5 / CRITICAL #1 (Recharts `touch-action: auto`
  causing scroll-lockup).
- **Files**: `src/components/charts/{health-chart, mood-chart,
medication-compliance-chart, compliance-line-chart,
scatter-correlation-chart}.tsx`,
  `src/components/charts/__tests__/touch-action-guard.test.ts` (new).
- **Change**: Added `touch-pan-y` Tailwind utility to every chart's
  wrapping `<div>`. The two charts that previously rendered
  `<ResponsiveContainer>` without an explicit wrapper (`compliance-
line-chart`, `scatter-correlation-chart`) gain a `<div className=
"touch-pan-y">` parent.
- **Evidence**: New textual guard test verified to fail on every
  chart before the fix, then turned green after. 5 / 5 chart files
  pass the contract; suite stays green at 863 tests total.

### Fix 2 — `41945b2` (commit-message race) — fix(admin): /admin/users mobile layout

- **Finding ID**: A5 / CRITICAL #2 (table truncates role badge,
  off-screen actions on mobile).
- **Files touched**: `src/components/admin/user-management-section.tsx`,
  `src/components/admin/__tests__/user-management-responsive.test.tsx`
  (new).
- **Change**: Header switches from `flex` to `flex-col sm:flex-row`
  so the filter pills stop colliding with the title's count badge.
  Card padding adapts `p-4 sm:p-6`. Desktop table gated behind
  `hidden md:block`. New mobile card-list (`<ul data-testid="admin-
users-mobile-list" className="md:hidden">`) renders each user as
  a self-contained card with all four action buttons (toggle role,
  edit, reset password, force-logout) flex-wrapping below the
  username + role badge + meta line. Action buttons extracted into
  a single `renderUserActions()` helper so desktop + mobile share
  exactly the same JSX.
- **Race note**: This commit's diff actually landed under another
  agent's playwright-config commit message (`41945b2`) — same
  shared-cwd race Marc documented in A2/A4. The code is correct; the
  message-to-diff mapping is misleading. New test file
  `user-management-responsive.test.tsx` (6 tests, all green) is
  also under that commit.
- **Evidence**: 6 / 6 new tests pass (asserts desktop/mobile dual
  composition, badge present in both branches, all four ARIA-labelled
  actions reachable on mobile, header stack on `< sm`, padding
  responsive).

### Fix 3 — `8370b2d` — fix(mobile): bump chart controls + medication primary buttons + mood list icons to 44px

- **Finding IDs (cluster)**:
  - A5 / HIGH `/` Dashboard — chart range buttons
  - A5 / MEDIUM `/` Dashboard — chart switch toggles (`scale-75`)
  - A5 / HIGH `/medications` — Taken/Skipped buttons sizing
  - A5 / HIGH `/mood` — list edit/delete sizing
  - A5 / MEDIUM `/medications` — history + edit icon buttons
- **Files**: `src/components/charts/{health,mood,medication-
compliance,compliance-line,compliance}-chart{s}.tsx`,
  `src/components/medications/medication-card.tsx`,
  `src/components/mood/mood-list.tsx`.
- **Change**: Chart range buttons `h-7 → min-h-9`; chart switches
  drop `scale-75` (return to default). Medication card primary
  buttons (Taken / Skipped) go from `size="sm"` → default + explicit
  `min-h-11`. Medication card icon buttons + mood-list mobile icon
  buttons `h-8 w-8 → min-h-11 min-w-11`. `DeleteButton` gains a
  `mobile` prop so the desktop callsite is unchanged.
- **Evidence**: 853 / 853 unit tests green at this point; visual
  spot-check of `medication-card.tsx` shows Taken/Skipped now match
  the WCAG floor.

### Fix 4 — `00f8cd5` — fix(settings): passkey list responsive — card view at < md

- **Finding ID**: A5 / HIGH `/settings/account` — passkey table.
- **Files**: `src/components/settings/account-section.tsx`.
- **Change**: Desktop table gated `hidden md:block`. Mobile card-
  list (`<ul data-testid="passkeys-mobile-list" className="md:hidden">`)
  paints each passkey as a card with name + device type + backup
  badge + created date + a `min-h-11 min-w-11` delete button. Adds
  `aria-label` to the desktop delete button which was missing one.
- **Evidence**: 847 / 847 unit tests green at commit time; the
  delete action is no longer hidden behind a horizontal scroll.

### Fix 5 — `c0b14f4` — fix(auth): bump login buttons to 44px tap-target on mobile

- **Finding ID**: A5 / MEDIUM `/auth/login` — Sign-in buttons.
- **Files**: `src/app/auth/login/page.tsx`.
- **Change**: Three login CTA buttons (passkey, password switch,
  password submit) get `size="lg"` + `min-h-11`. First-time-user
  flow now meets the WCAG 2.5.5 floor.

## Deferred — picked up by future agent or v1.4.16

| Audit ID                                                            | Reason                                                                                                                | Recommended owner            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A5/HIGH `/insights` tab strip overflow                              | Cross-cutting `tabs.tsx` primitive change touches `/settings/*` + `/admin/*` too. Best done as one consolidated pass. | v1.4.16 design-systems sweep |
| A5/HIGH `/admin` tab strip overflow                                 | Same reason — single fix for both Settings and Admin.                                                                 | v1.4.16 design-systems sweep |
| A5/HIGH `/measurements` BP grouping (sys + dia → "117/79 mmHg" row) | Logic change to `measurement-list.tsx`, larger scope than tap-target sweep. Doctor-export UX impact.                  | v1.4.16 measurements polish  |
| A5/HIGH `/measurements` hidden table DOM weight                     | Coupled to BP grouping fix.                                                                                           | v1.4.16 measurements polish  |
| A5/HIGH bottom-nav 7-items → 5+More                                 | Requires nav-IA decision (which 2 to demote — Achievements + Targets per audit, but needs Marc sign-off).             | v1.4.16 nav-IA review        |
| A5/MEDIUM `/admin` system-status loading-failed state               | Touches `system-status-section.tsx`; B-agent-3 (notifications) and B1 (backups) are also touching admin sections.     | v1.4.16 admin polish         |
| A5/MEDIUM tabs h-9 default                                          | Same `tabs.tsx` primitive — group with HIGH tab-strip wrap.                                                           | v1.4.16                      |

## Cross-agent observations

- The shared-cwd race Marc documented in A2 / A4 reproduced again:
  twice during this phase a `git commit` consumed a sibling agent's
  staged files instead of mine. **Mitigation**: switched to `git
commit -- <pathspec>` for atomic stage-and-commit, which fixed it
  for fixes 3 / 4 / 5. Recommend the v1.4.16 marathon use the
  `superpowers:using-git-worktrees` skill to give each agent its
  own working tree.
- One pre-existing typecheck error in `src/lib/__tests__/dashboard-
layout.test.ts` (DashboardWidgetId narrow type vs string) is
  unrelated to my work — confirmed by stashing my changes and
  rerunning. Filed as v1.4.16 backlog.
- Pre-existing Playwright config + a11y dark-color-scheme work
  landed on main mid-session under `41945b2` and grafted my
  user-management changes into the same commit. Code is correct;
  message-to-diff mapping for `41945b2` is wider than its title.

## Verification snapshot at end of phase

- `pnpm test` → 863 / 863 unit tests pass (was 812 at phase start;
  +5 touch-action guard + 6 user-management responsive + 40 from
  sibling agents' parallel work).
- `pnpm lint` → 0 errors, 12 warnings (pre-existing, none in B-mobile-
  authored files).
- `pnpm typecheck` → 1 pre-existing error in `dashboard-layout.test.ts`
  (unrelated; reproduced on `git stash`).
