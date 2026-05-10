# Phase A2 — `/admin/api-tokens` painted scrollbar (3rd attempt)

Marathon: v1.4.18 Wave-A
Agent: A2 (parallel with A1, A3, B1)
Started: 2026-05-10T10:08+02:00
Finished: 2026-05-10T10:21+02:00
Commit: `3e16074` on origin/main

## Root cause — confirmed against PROD

The two earlier fixes (v1.4.15 column-hide, v1.4.16 mobile card-list)
both targeted `<ApiTokenOverviewSection>`. They did remove overflow
inside that card, and the production probe confirmed it: at Pixel-5
(393 CSS px) the api-tokens card now reports `scrollWidth=327,
clientWidth=327, diff=0` and the document itself reports
`scrollWidth=innerWidth=393` — zero page-level horizontal overflow.

The actual scrollbar Marc kept reporting lives one component up, in
`<AdminShell>`. Its mobile section strip is a horizontal flex with
13 admin entries and an `overflow-x-auto` wrapper. At Pixel-5 the
strip reports:

```
<nav aria-label="Admin sections"
     class="-mx-4 mb-4 overflow-x-auto px-4 md:hidden">
  scrollWidth: 1692
  clientWidth:  361
  diff:        1331
```

The strip sits right above the api-tokens card (`rectTop: 112`, three
lines below the topbar), which is why each previous fix attempt felt
like it should have helped — Marc was looking at the strip's
scrollbar, but reporting the page he was on.

`<SettingsShell>` is the exact same pattern with 10 entries and the
same defect; both shells were fixed.

## Playwright proof

Probe script: `/tmp/v1418-api-tokens-prod-probe.mjs` (uses Marc's
session cookie `cmox4d6fj000101p8w9ykhcnm`, viewport Pixel-5).

Pre-fix readings against `https://healthlog.bombeck.io/admin/api-tokens`:

```
[393x851] dims= { docScrollWidth: 393, innerWidth: 393, ... }
[393x851] overflow culprits (top of list by diff):
  <nav.overflow-x-auto> sw=1692 cw=361 diff=1331
  <span.truncate> sw=331 cw=269 diff=62  (text-overflow:ellipsis,
                                          no painted scrollbar)
[1920x1080] dims delta = 0
```

Post-fix the strip still reports `scrollWidth > clientWidth` (so swipe
and keyboard-arrow scrolling stay), but with `scrollbar-width: none`
+ `::-webkit-scrollbar { display: none }` the painted bar no longer
draws. CSS-isolation probe (`/tmp/v1418-css-probe.html` +
`v1418-css-probe.mjs`) verified the rule applies cleanly.

Screenshots: `/tmp/v1418-api-tokens-prod-393x851.png` (pre-fix prod),
`/tmp/v1418-api-tokens-prod-1920x1080.png` (desktop sanity),
`/tmp/v1418-css-probe-pixel5.png` (CSS-fix isolation probe).

## Fix

`src/app/globals.css` — added a small `.no-scrollbar` utility:

```css
.no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
```

`src/components/admin/admin-shell.tsx` and
`src/components/settings/settings-shell.tsx` — added `no-scrollbar`
to the mobile `<nav>` strip class list. Both shells share the same
horizontal-strip pattern so both got the same fix.

## Tests

- New `src/components/admin/__tests__/admin-shell.test.tsx` — locks
  in the class (and the rest of the shell behaviour: per-section
  links, aria-current, derive-from-pathname).
- `src/components/settings/__tests__/settings-shell.test.tsx` —
  added the matching `no-scrollbar` assertion.
- `e2e/admin-api-tokens-mobile.spec.ts` — added a regression test
  that asserts the strip declares both `no-scrollbar` and
  `overflow-x-auto`, and that internal scroll is preserved
  (`scrollWidth > clientWidth`).

## Verification

- `pnpm test`: 1559 / 1559 green
- `pnpm typecheck`: clean
- `pnpm lint`: 0 errors / 12 pre-existing warnings (baseline)

## Surfaces and constraints

Touched only the assigned A2 surface (`<AdminShell>`, css utility,
api-tokens e2e) plus the matching settings-shell pattern (same
defect, no other agent owns settings-shell). Did not touch
`src/lib/insights/*`, `src/components/charts/*`, or
`src/lib/achievements/*`. No new dependencies.

Single commit `3e16074` on origin/main, pushed without --no-verify
or --no-gpg-sign.
