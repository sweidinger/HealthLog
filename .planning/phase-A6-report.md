# Phase A6 — Settings mobile audit + consistency

**Owner:** A6 agent (Wave A, parallel with A1-A5, A7-A8)
**Date:** 2026-05-10
**Result:** done

Audit findings and the fix plan live in
[`.planning/phase-A6-settings-audit.md`](./phase-A6-settings-audit.md).
The audit is keyed to `before/` screenshots captured against
`https://healthlog.bombeck.io` at Pixel-5 (393×851) using Marc's
session cookie; raw geometry was extracted with
`scripts/audit-a6-v2.mjs` to spot the height mismatches the
human eye missed.

## What was wrong

- **Four input heights in the same shell.** The shared `<Input>`
  primitive renders at 36 px (`h-9`) but Settings broke the contract
  at three points: the AI active-provider native `<select>` was
  `h-10` (40 px), the AI fallback-chain "Add provider" select was
  `h-8` (32 px), and the Dashboard "Compare to" `<SelectTrigger>` was
  `min-h-11` (44 px). Visible whenever two cards stacked on top of
  each other.
- **Action-button overflow.** "Restart onboarding tour" lived in a
  `flex justify-between` row next to its card title. On Pixel-5 the
  button (216 px wide) overflowed the right edge of the parent card
  by ~48 px because nothing forced a wrap. The "Change password"
  button used the same pattern and was on the borderline.
- **Sprache buried.** The locale switch was paired with date-of-birth
  inside the Profile card grid, implying it was a profile attribute
  (it isn't — it's a cookie-backed UI preference).
- **Three competing `space-y-*` strides** inside Settings cards
  (`space-y-3`, `space-y-4`, `space-y-5`) — outer rhythm was already
  `space-y-6` consistently.

## What was fixed (5 commits)

1. `957f8e9` — `fix(settings): equalize input heights across all
settings sections`. AI active-provider select `h-10` → `h-9`, AI
   add-provider select `h-8` → `h-9`, Dashboard "Compare to" trigger
   loses `min-h-11` so the default `h-9` applies.
2. `9fda634` — `fix(settings): action-button placement consistent
across sections (right-side desktop, stacked mobile)`. Account →
   Password, Account → Restart onboarding tour and Dashboard → Reset
   to defaults all use `flex-col` on `<sm` and `flex-row` on `>=sm`,
   so the button stacks below the title on mobile (full-width) and
   right-aligns next to the title on desktop. Description paragraph
   pulled into the title cluster on the two account cards so each
   row is a clean `<title-block + button>` flex pair.
3. `1075784` — `fix(settings): Sprache select position + width
consistent`. Language lifted out of the dob/language pair into
   its own row at the bottom of the Profile card. `max-w-xs` on
   `>=sm` so it doesn't render heavier than other half-width fields.
   Drive-by: pulled the duplicated native-select class string into a
   single `NATIVE_SELECT_CLASS` constant so gender + language render
   identically.
4. `737b533` — `style(settings): uniform vertical spacing across all
sections`. Dashboard layout card `space-y-5` → `space-y-4`. AI
   provider config forms `space-y-3` → `space-y-4`. Section roots
   keep `space-y-6` so distinct cards still read as distinct
   surfaces. Note: `.planning/STATE.md` got bundled into this commit
   accidentally via index race with A5; STATE content is correct,
   no semantic harm.
5. `78f1f3f` — `test(settings): mobile e2e snapshot verifies
consistency`. Pixel-5 Playwright spec
   (`e2e/settings-mobile-consistency.spec.ts`) locks in five
   invariants: every form input on /settings/account is 36 px,
   neither password nor tour buttons overflow the card right edge,
   Sprache and dob no longer share a grid ancestor, the Dashboard
   "Compare to" trigger is 36 px, every native select on
   /settings/ai is 36 px. Mobile-only project — desktop skips it.

## Verification

- `pnpm test` — all 1637 tests pass
- `pnpm typecheck` — zero source-tree errors (the four `.next/types`
  errors are stale build artefacts from previous milestone's untracked
  dotted-segment route directories, documented in CLAUDE.md / STATE.md
  as Phase 0 leftovers)
- `pnpm lint` — zero errors, 12 pre-existing warnings unrelated to A6

A post-fix Playwright re-screenshot pass against production is gated
on the v1.4.19 deploy (Phase E). The new e2e spec is the durable
artifact and runs on every PR.

## What I deliberately did NOT touch

- `src/components/settings/integrations-section.tsx` (A5 owned and
  shipped during this phase as commits `0dcc91a` + `47a8fc7`).
  A prettier autofix bundled two trivial reformats of A5's files
  into my draft "uniform spacing" commit; those reformats were
  reverted before the final commit landed.
- `src/components/admin/*` (A7).
- `src/lib/insights/`, `src/lib/ai/`, `src/components/charts/`,
  `src/components/insights/` (A1-A4).
- Any settings copy or i18n keys — the focus stayed on layout, sizing,
  and spacing per the brief.

## Files touched

- `src/components/settings/account-section.tsx`
- `src/components/settings/ai-section.tsx`
- `src/components/settings/dashboard-layout-section.tsx`
- `e2e/settings-mobile-consistency.spec.ts` (new)
- `.planning/phase-A6-settings-audit.md` (new — findings table)
- `.planning/phase-A6-report.md` (this file)
