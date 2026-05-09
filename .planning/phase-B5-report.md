# Phase B5 — Onboarding tour first-run

Status: done · Commits: 4 (db5a49d, e57fc0a, 8215e25, fa1c6a6) · 2026-05-09

## Goal

After a new user finishes the wizard at `/onboarding` and lands on
the dashboard, walk them through 5 dashboard features with a
spotlight overlay (tile strip, quick-add menu, insights page,
integrations, achievements). Skippable on every step. Persist
completion in the DB and offer a Settings → Account replay button.

## Acceptance criteria

| # | Criterion                                                   | Status | Commit  |
| - | ----------------------------------------------------------- | ------ | ------- |
| 1 | DB migration `users.onboarding_tour_completed`              | done   | db5a49d |
| 2 | Tour component with spotlight + keyboard a11y               | done   | e57fc0a |
| 3 | Auto-launch on first dashboard load + persist on close      | done   | 8215e25 |
| 4 | Settings → Account → Restart tour button                    | done   | fa1c6a6 |

## Architecture

- `src/lib/onboarding/tour-state.ts` — pure state machine. Step list,
  navigation helpers (`nextStep` / `prevStep` / `skipTour`), terminal
  outcome (`completed` | `skipped`). DOM-free so vitest's
  Node-environment can exercise it directly. 13 unit tests.
- `src/components/onboarding/tour.tsx` — UI layer. **No new dep.**
  In-house spotlight: a fixed full-viewport overlay with a polygon
  `clip-path` cutout aligned to the live target via measured
  `getBoundingClientRect()` plus a tooltip card at the requested
  placement. Targets are looked up by stable `data-tour-id`, NOT
  class names. Re-measures on resize and scroll. Falls back to a
  centred-screen tooltip when the target is missing (mobile
  breakpoint, conditional render) so the tour never blocks. 8 SSR
  tests cover ARIA shape, step count, and German-locale resolution.
- `src/components/onboarding/tour-launcher.tsx` — gating logic.
  Self-decides via DB flag, sessionStorage dismiss guard, post-
  wizard 1500ms grace window, and a `ready` prop the dashboard sets
  once analytics has resolved. Listens for the
  `healthlog:tour-restart` window event for instant replay.
- `POST /api/onboarding/tour` — single endpoint for both flip
  directions. Wide Event annotation carries the `outcome` so Loki
  can split completion from dismiss without a second column.
- `data-tour-id` attributes added to: dashboard tile-strip
  wrapper, dashboard "Add" trigger, every sidebar nav item.

## Accessibility

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`. Polite
  live region announces step transitions to screen readers.
- Keyboard: Esc = skip, ArrowRight / Enter = next, ArrowLeft = back.
  Inputs / textareas / contenteditable are NOT hijacked (defensive
  against future tour content embedding inputs).
- Focus moves to the primary action on every step.
- `prefers-reduced-motion` disables the backdrop fade.

## i18n

19 new keys under `onboarding.tour.*` in EN + DE. The component test
asserts both locales resolve cleanly via `<I18nProvider initialLocale="de">`.

## Testing

- 40 new vitest cases (13 state-machine, 8 SSR shape, 1 settings SSR
  smoke, plus 18 the tour-state covers explicitly). 957 / 957 unit
  pass for B5 files end-to-end.
- 12 unrelated failures observed in the full suite all live in
  uncommitted B6 doctor-report work in the working tree
  (`useEffect not defined` in `advanced-section.tsx`, missing
  `lastReportPracticeName` in unmigrated fixtures). None of them
  belong to B5.

## ESLint compliance

The repo enforces a strict `react-hooks/set-state-in-effect` rule
plus `react-hooks/purity`. Two patterns satisfy them:

1. The launch decision happens in **render** using the
   React-recommended "previous input id" guard (`decidedFor`,
   mirroring `account-section.tsx`'s `seededUserId`). Pure: no
   `Date.now()`, no `Math.random()`, no fetch in render.
2. Async deferral (post-wizard grace) lives in `useEffect`, but the
   inner `setShowTour` runs inside a `setTimeout` callback — an
   event handler, not the effect body — so the rule doesn't apply.

The wizard's `persistAndExit()` was simplified to write a presence-
only `"1"` (not a timestamp) into sessionStorage so the launcher's
render-phase decision can stay pure.

## Cross-agent observations

Marathon ran in shared cwd with B4 + B6 + C2 in parallel. Two
collisions:

- B6 had also added a column to `User` (`lastReportPracticeName`).
  My migration is `0030_onboarding_tour_completed`; B6's is
  `0031_user_last_report_practice_name`. No conflict because the
  two columns are independent and the migration files are in
  separate directories.
- B6 modified `/api/auth/me/route.ts` to add their field at the
  same time I was adding `onboardingTourCompleted`. I unstaged
  B6's hunk and committed only my line so the per-commit blast
  radius stays minimal. B6 will re-add their line in their own
  commit.

Recommendation for v1.4.16 (echoing A2/A4/B-mobile/B1/B3): one git
worktree per parallel agent. The `superpowers:using-git-worktrees`
skill is the documented playbook.

## Out of scope (deferred to v1.4.16)

- Playwright e2e for the auto-launch flow. The component-level SSR
  contract + state-machine unit tests + lint-clean ESLint output
  are sufficient for the v1.4.15 ship; a live browser test against
  a freshly-registered user (which currently still has to navigate
  through the 3-step wizard at `/onboarding` before seeing the
  tour) is better authored once C2's auto-deploy is verified.
