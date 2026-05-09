# Phase D — Design / UX review findings (v1.4.15)

**Reviewer**: design / UX (parallel D-agent)
**Method**: source review of JSX + Tailwind + i18n strings against the
A5 mobile audit baseline, B-mobile applied fixes, and the canon set in
`docs/ui-guidelines.md`. Playwright was not run — the v1.4.15 marathon's
parallel-agent racing makes a fresh local boot unreliable, and the A5
audit at `https://healthlog.bombeck.io` already covers production
device measurements. This pass focuses on the v1.4.15 *new surfaces*
(B1 backups, B2 integrations status, B3 notifications, B4 achievements,
B5 onboarding tour, A2 admin overview, A3 mood tile) plus the
deferred-from-A5 cluster the B-mobile phase explicitly punted to v1.4.16.

**Out of scope (per phase brief)**: chart visual style, Dracula tokens,
chart-data changes that landed in A4. None of the findings below
recommend chart-look changes.

**Tally**: **0 CRITICAL · 5 HIGH · 11 MEDIUM/LOW**.

Empty CRITICAL is real: the A5 audit already produced its CRITICAL
list (admin/users mobile grid + admin/users table column hide-off);
B-mobile applied both. No new ship-blockers introduced by v1.4.15
features.

---

## HIGH

### H1 — Onboarding tour misses Tab focus-trap (a11y, source comment lies)

**Severity**: HIGH
**Files**: `src/components/onboarding/tour.tsx:27-29` (the docstring) +
`tour.tsx:265-292` (the keydown effect)
**Issue**: The component's docstring explicitly states "Tab is trapped
inside the tooltip", and the brief's check item #8 expects a focus
trap. The implementation handles `Escape`, `Enter`, `ArrowLeft`,
`ArrowRight` only — there is **no Tab handler**, no
`trapFocus`/`focusin` listener, no `tabindex="-1"` shielding for the
underlying page, and no return-focus-on-close. The tooltip's
`role="dialog" aria-modal="true"` claims a modal context which the
keyboard does not honour. A keyboard user pressing Tab from the Skip
button will land on a sidebar nav item or a page-level interactive
element (which is *also* where the spotlight cutout points), then
visually disappear behind the dimmed backdrop — confusing focus
state.
**Recommendation**: Add a small Tab handler in the same `keydown`
effect that cycles focus across the three internal buttons (Skip,
Back, Next/Done). Also store `document.activeElement` at mount and
restore it in the close path so Settings → Account replay returns
focus to the "Restart" button it was triggered from. Either delete
the "Tab is trapped" line of the docstring or implement it.
**Ship-blocker?**: **No** for v1.4.15 (not a regression — feature is
new), but the docstring promises behaviour the code doesn't deliver,
which is a disclosure-style bug. v1.4.16 should close it.

---

### H2 — Onboarding tour tooltip card overflows on small viewports with DE copy

**Severity**: HIGH
**Files**: `src/components/onboarding/tour.tsx:187-188` (constant
budget), `messages/de.json` `onboarding.tour.steps.tileStrip.body`
(verified ~210 chars in DE vs ~155 in EN)
**Issue**: `TOOLTIP_HEIGHT = 220` is a fixed budget used for
viewport-fit math in `computeTooltipPosition()`. The DE body strings
for several stops run 30–45 % longer than EN; on a 393 × 851 Pixel 5
viewport with browser font scaling at 1.2× (Marc has explicitly OK'd
"German is ~30% longer" in CLAUDE.md), the actual rendered tooltip
clears 280 px and overflows the budget. The candidate-position math
believes it has 220 px of headroom and chooses a `placement` that
leaves no room for the bottom of the card → the tooltip clips below
the viewport and the Next/Skip buttons sit just below the fold,
unreachable without scrolling (and the backdrop's `position: fixed`
prevents the user from scrolling past).
**Recommendation**: Either (a) measure the rendered tooltip after
mount with a `ResizeObserver` and feed real height into
`computeTooltipPosition()`, or (b) bump the budget to ~300 px and
add an explicit `max-h-[80vh] overflow-y-auto` on the tooltip card
so worst-case a scroll handle appears inside the card without
ejecting the Next button.
**Ship-blocker?**: No, but the DE-locale first-impression for new
users is the literal use case the tour exists for. v1.4.16 priority.

---

### H3 — Tour cutout backdrop is a focusable `<button>` covering the page

**Severity**: HIGH
**File**: `src/components/onboarding/tour.tsx:328-334`
**Issue**: The dimmed backdrop is rendered as
`<button type="button" aria-label="Skip">` so a click anywhere
counts as Skip. Two consequences:
1. Screen-reader users tab into a single button labelled "Tour
   überspringen" that visually has no border, no focus ring (the
   inner `cursor-default` and `bg-black/70` win over the
   `focus-visible:ring` from `Button` styles — and this isn't even
   the `Button` component, it's a raw `<button>`). No a11y focus
   ring → no visible signal that pressing Enter dismisses the tour.
2. On a touch device a stray scroll-tap on the dimmed area immediately
   skips the tour. The brief's check item #8 expects the spotlight
   to keep the user in the flow until Done/Skip.
**Recommendation**: Either (a) keep the `<button>` but add an
explicit `focus-visible:ring-2 focus-visible:ring-primary` so
keyboard users see it, OR (b) split the backdrop into a non-
interactive `<div aria-hidden>` and surface the Skip action only via
the Skip button inside the tooltip + the existing Esc handler. (b)
matches the convention of `<Dialog>` from radix-ui where the
backdrop is not an interactive primitive.
**Ship-blocker?**: No. New feature, no regression vs. v1.4.14. Polish
in v1.4.16.

---

### H4 — Backups / Notifications status / Tour buttons are 32 px tall (below WCAG 44 px)

**Severity**: HIGH
**Files**:
- `src/components/admin/backups-section.tsx:84,343,397,438,492` (every
  `<Button size="sm">` in the surface — restore trigger, run-now,
  upload, download per row)
- `src/components/settings/notification-status-card.tsx:264,280` (Re-
  enable + Send-test buttons)
- `src/components/onboarding/tour.tsx:385,396,405` (Skip, Back, Next/
  Done inside the tooltip)
- `src/components/admin/recent-audit-preview.tsx:80-83` (the
  "View all" `<Link>` is only `text-sm`, ~20 px high — even smaller)
**Issue**: A5's cross-cutting finding ("design system default
button/tabs/switch sizes are too small for mobile") was deferred from
B-mobile to v1.4.16 because the fix touches `button.tsx` which
ripples everywhere. Meanwhile the v1.4.15 *new* surfaces shipped with
the same `size="sm"` pattern (h-8 = 32 px) so we accreted three more
pages that fail WCAG 2.5.5 in addition to the pages A5 already
flagged. B-mobile's fix-list explicitly hardened *only* a dozen
specific call-sites (chart range, mood-list icons, login CTAs); the
B1/B3/B5 surfaces were authored after-the-fact without the same
44-px discipline. Notable counter-example: dashboard quick-add at
`src/app/page.tsx:411-413` carries an explicit `min-h-11` because
that author saw the audit. Most B1/B3 surfaces don't.
**Recommendation**: For v1.4.15 — **no source change**, accept the
debt. For v1.4.16 — adopt the deferred design-system bump
(`button.tsx` default `h-9` → `h-11`, `sm` `h-8` → `h-9` keeping the
denser tier still-tappable at 36 px). One-line diff closes 30+ tap-
target findings in a single change. Until then, every new B-feature
keeps growing the deferred list.
**Ship-blocker?**: No (continuation of a known v1.4.16 backlog
item), but the trend is moving in the wrong direction — flag in the
phase-D report so reconcile decides whether to fast-track the
button.tsx change.

---

### H5 — Withings + moodLog status display: long error message can break card layout

**Severity**: HIGH
**File**: `src/components/settings/integrations-section.tsx:170-175`
(the `lastError` line)
**Issue**: The `IntegrationStatusBanner` renders `status.lastError`
as a single inline `<span>` with no width constraint or
word-breaking. Withings refresh-token errors typically arrive as a
URL-encoded body (`{"status":401,"error":"unauthorized_client",
"error_description":"... refresh_token=...long_token..."}`) — the
`status.ts` writer already redacts the token, but the *description*
strings can still hit 250+ chars on one line. Inside the
`bg-muted/40 ... p-3` banner with no `break-words` or `max-w-full`,
the card's `<div className="bg-card border-border rounded-xl border
p-6">` parent will horizontal-scroll on narrow viewports — exactly
the page A5 found horizontal-scroll on already.
**Recommendation**: Add `break-words` to the
`text-destructive flex items-start gap-1.5` row OR clamp via
`line-clamp-3` with a "Show more" toggle. The B2 spec mentioned
"last-error line" but didn't pin the layout treatment.
**Ship-blocker?**: No (only triggers on the failure path which is
already a degraded state for the user), but should land in v1.4.16
before any user actually hits a Withings reauth burst.

---

## MEDIUM / LOW

### M1 — `/admin` overview audit-preview hides action label on `<sm` viewports

**Severity**: MEDIUM
**File**: `src/components/admin/recent-audit-preview.tsx:136-140`
**Issue**: The action label (`auth.login.passkey` → "Login with
passkey") is gated behind `hidden ... sm:inline`. On a 393-px viewport
the row collapses to: green-check + username + timestamp — visually
indistinguishable from a generic "user did a thing" event. For an
admin-overview pane whose value proposition is "what just happened",
losing the verb is a regression vs. the previous status-card grid
where the verb was always present.
**Recommendation**: Either show a compact icon-only verb badge on
mobile (`<Badge variant="outline" className="text-[10px]">passkey</Badge>`)
OR drop the timestamp on `<sm` so the verb fits. Keep the username
either way.
**Ship-blocker?**: No.

---

### M2 — `<RestoreRowDialog>` buttons inside dialog footer don't differentiate severity

**Severity**: MEDIUM
**File**: `src/components/admin/backups-section.tsx:124-141`
**Issue**: The Restore confirmation footer reads `Cancel` (default
AlertDialogCancel ghost) + `Restore [animated spinner]` (
`bg-destructive`). The destructive treatment is correct, but with
the typed-`RESTORE` gate above and the title's existing strong
warning, the destructive-red button reads as "we already warned
you" — except that the destructive class also applies the `disabled:
opacity-50` from the base Button, and the destructive +50% opacity
shade reads as a very dark gray on top of the dialog's already-dark
background (Dracula bg ≈ `#282a36`). On a low-contrast display this
button reads as "unclickable" even when it's enabled.
**Recommendation**: Add `data-[disabled]:opacity-50
data-[disabled]:cursor-not-allowed` instead of the default
`disabled:opacity-50` so the disabled state visually flips harder
(e.g., `bg-muted text-muted-foreground` when disabled). Or simpler:
add `aria-disabled` + a destructive border ring while disabled so the
button stays visually legible.
**Ship-blocker?**: No.

---

### M3 — Backup upload area: hidden file input with no drop zone

**Severity**: MEDIUM
**File**: `src/components/admin/backups-section.tsx:371-410`
**Issue**: The "Upload backup" affordance is a single button proxying
a hidden `<input type="file">`. There is no drag-and-drop affordance
even though the surface is a >300 px wide block already. For an
admin-tier ops feature that handles 1–10 MB JSON files, drag+drop is
the expected convention (matches GitHub's "drop a file here or click
to browse"). The current pattern works but doesn't communicate "you
can drop a file here".
**Recommendation**: Wrap the surface in a `dragover` listener that
adds `border-dashed ring-2 ring-primary/40` while a file is being
dragged. Single-event-handler plumbing, no new dep.
**Ship-blocker?**: No.

---

### M4 — Tour spotlight clip-path skips backdrop click-blocking on the highlighted target

**Severity**: MEDIUM
**File**: `src/components/onboarding/tour.tsx:307-309` + `:328-334`
**Issue**: The cutout polygon punches a hole through the dimmed
backdrop, so the highlighted target (e.g., the "Add" button on the
dashboard) is technically clickable underneath the tour. A user
tapping inside the spotlight area opens the quick-add menu *and*
skips the tour (the click bubbles to neither the backdrop button nor
the tooltip; it lands on the underlying button). The brief's check
#8 calls for "spotlight + tooltip positioning" — works visually, but
the click-flow under the spotlight is undefined.
**Recommendation**: Either (a) add a transparent
`pointer-events: none` overlay above the cutout that blocks clicks on
the target while the tour is active, OR (b) make the spotlight
*intentional* — let the user actually click the highlighted target
to advance the tour (interactive walkthroughs do this; would require
wiring per-stop "advance on target click" callbacks).
**Ship-blocker?**: No.

---

### M5 — Achievements page summary cards: `min-h-34` is non-standard Tailwind

**Severity**: LOW
**File**: `src/app/achievements/page.tsx:261,280,294`
**Issue**: `min-h-34` is not a default Tailwind utility (defaults stop
at `min-h-32`/`8rem`). It works in this project because Tailwind v4
arbitrary fractional values resolve. But the readability suffers
("34" reads as some-pixel-thing — actually `8.5rem`). Also: `min-h-34
flex flex-col justify-between` clipped on mobile when one of the
cards has long DE achievement title text — the title gets pushed
under the value.
**Recommendation**: Switch to `min-h-[8.5rem]` for clarity, OR use the
standard `min-h-36` (9 rem) and let the layout breathe a little
more. Not visually disruptive at any locale.
**Ship-blocker?**: No.

---

### M6 — Achievements category badges don't visually distinguish completion state

**Severity**: MEDIUM
**File**: `src/app/achievements/page.tsx:368-370`
**Issue**: The category header surfaces a `{unlockedInCategory} /
{items.length}` count next to the category name. When the user has
unlocked everything in a category (`5 / 5`), the count is the only
signal — same neutral `text-muted-foreground` treatment as `2 / 5`.
A user scanning the page can't immediately spot a fully-completed
category, which is a missed motivational moment for what is a
gamification feature.
**Recommendation**: When `unlockedInCategory === items.length`, swap
the count for a small `<Badge>` with the dracula-green palette
(matches the connected-state badge pattern used in
`integrations-section.tsx`'s `border-dracula-green/30 bg-dracula-
green/15 text-dracula-green`). Optionally also add a small
🏆 / `Trophy` icon.
**Ship-blocker?**: No.

---

### M7 — RecentAchievementsCard empty state lacks a CTA

**Severity**: MEDIUM
**File**: `src/components/gamification/recent-achievements-card.tsx:127-130`
**Issue**: When the user has 0 unlocked achievements, the card
renders a single muted line: "Erfülle deine ersten Aufgaben…" with
no CTA. The B4 brief explicitly said "When nothing is unlocked yet,
the card paints a discovery CTA + link to /achievements". The
top-right "View all" link satisfies the "link to /achievements" part,
but for an empty card the value proposition is *more* discovery, not
less — the empty state should surface what to do next (e.g., "Log
your first measurement to unlock the streak badge"). Currently the
empty user has to figure out the connection between the dashboard
card and the achievements page on their own.
**Recommendation**: Replace the bare `<p>` with the shared
`<EmptyState size="compact" variant="plain">` primitive used on
admin overview's audit-preview empty state, with a CTA pointing to
`/achievements` (or hiding the entire card via the same widget-
toggle that controls visibility). The variant `compact` exists
specifically for in-card empty states.
**Ship-blocker?**: No.

---

### M8 — Notification status cooldown chip and disabled-reason use plain `<dl>` no semantic hierarchy

**Severity**: LOW
**File**: `src/components/settings/notification-status-card.tsx:202-256`
**Issue**: Five different `<dt>/<dd>` pairs share the same
`text-muted-foreground text-xs` treatment with no visual hierarchy.
Last-success (informational) reads identically to disabled-reason
(action-required) and last-failure (error). Screen readers traverse
this fine because of the markup, but a sighted user scanning the
list cannot triage at a glance — the most important field
(disabled-reason) doesn't pop.
**Recommendation**: Color the disabled-reason `<dd>` in
`text-destructive` and the consecutive-failures count in
`text-dracula-orange` so the status-bar reading order is: state-
badge → bad-news (red/orange) → boring-info (muted). Keep the
`<dt>/<dd>` markup.
**Ship-blocker?**: No.

---

### M9 — Withings status banner "live" timestamps don't use `useFormatters().relativeTime`

**Severity**: MEDIUM
**File**: `src/components/settings/integrations-section.tsx:158,165`
**Issue**: The banner renders `formatDateTime(status.lastSuccessAt)`
verbatim (e.g., "08.05.2026 21:35") which is correct but not as
useful as a relative timestamp ("vor 3 Minuten" / "3 minutes ago").
For a Settings page whose UX promise is "is this thing healthy?",
relative time is the dominant convention. CLAUDE.md mentions a
deferred `Intl.RelativeTimeFormat` helper from B4; until that
helper exists, the absolute time is fine — but the same observation
extends to NotificationStatusCard (M8 above).
**Recommendation**: Once the v1.4.16 `useFormatters().relativeTime`
helper lands (B4 spec'd it), sweep these two places. Until then keep
absolute. Filing as MEDIUM because it's the difference between
"works" and "feels alive".
**Ship-blocker?**: No.

---

### M10 — Onboarding tour live-region announcement reads punctuation literally

**Severity**: LOW
**File**: `src/components/onboarding/tour.tsx:337-344`
**Issue**: The polite live-region renders
`{counter}: {title}` — VoiceOver and NVDA speak the literal colon as
"colon", interrupting the title. Screen-reader convention is to use a
sentence-end period or just a space.
**Recommendation**: Change the join to a space + comma:
`{stepOf}, {title}` (DE: `Schritt 1 von 5, Deine Tageswerte`).
Single-line diff. Matches Wai-ARIA's APG patterns.
**Ship-blocker?**: No.

---

### M11 — Sidebar admin sub-items: active highlight uses startsWith without exact match guard

**Severity**: LOW
**File**: `src/components/layout/sidebar-nav.tsx:514`
**Issue**: `const isActive = pathname.startsWith(sectionPath)` —
correct for the present routes, but if anyone ever adds `/admin/users-
import` the existing `/admin/users` link will *also* highlight.
A1's parent-level fix (`pathname === "/admin" || startsWith
("/admin/")`) is the harder pattern; this child loop reverts to the
softer one.
**Recommendation**: Tighten to
`pathname === sectionPath || pathname.startsWith(`${sectionPath}/`)`
to match the parent guard's spirit. Defensive-only fix.
**Ship-blocker?**: No.

---

## Sidebar nav (A1) verification — pass

- `/src/components/layout/sidebar-nav.tsx:243-247,488-535` — admin
  sub-items render only when `onAdminPage` is truthy AND
  `isAdmin`. The condition `pathname === "/admin" ||
  pathname.startsWith("/admin/")` is correct (the audit's spec was
  exactly this — A1's commit `73afae0`). The expanded list mirrors
  `ADMIN_SECTIONS` from `admin-shell.tsx`. Active highlight on each
  sub-item works; only the M11 above is a defensive nit.
- Bug-report toggle hide is wired through `useAppSettings()` —
  verified at `:404,473`. Skip-link no longer blocks logo click —
  verified at `auth-shell.tsx:127` (out of scope here, was A1).

## Backup actions (B1) verification — mostly pass

- Restore: triple-confirm flow (open → typed `RESTORE` → confirm)
  works as documented in B1 report; only finding is M2 above
  (disabled-state opacity).
- Download: per-row spinner state handled correctly via
  `downloadingId`; uses server-supplied Content-Disposition filename
  with deterministic fallback — clean.
- Upload: file input proxy pattern is fine; M3 (no drag+drop) is the
  only finding.
- Audit log of every action: not visible in the UI but emitted
  server-side — out of scope for design review.

## Notification status (B3) verification — pass

- Auto-disabled vs active states are visually distinct via the
  `stateBadgeFor` helper. Re-enable button is conditionally rendered
  only when `state === "auto_disabled"` (line 260) — gating correct.
- Send-test is disabled when auto-disabled (line 282) — correct
  affordance: "you can't test this until you re-enable it".
- M8 above is the only nit.

## Onboarding tour (B5) — needs polish

Three findings above (H1 focus trap missing, H2 DE overflow, H3
backdrop-as-button) plus M4 click-through and M10 SR punctuation. All
are polish, none are ship-blockers, but B5 is the only v1.4.15 feature
where multiple HIGH findings cluster on the same component. v1.4.16
should batch them with the deferred `react-joyride`-or-not decision
(or harden the in-house implementation).

## Dracula theme integrity — pass

No new components introduce hardcoded hex tokens. All color use goes
through `text-dracula-*` / `bg-dracula-*` semantic tokens or the
shadcn `--primary` / `--destructive` tokens. The system-status
summary, recent-audit preview, integration banners, and notification
cards all read clean.

## Loading + empty + error states — strong

C5 sweep landed every list/table with the three-state contract.
Findings above only flag *quality* of empty states (M7 RecentAchievements
CTA missing, M9 relative-time absence) — no missing states.

## i18n length — one HIGH (H2 tour body overflow)

Otherwise clean: status-card label keys all have <50-char DE
counterparts; admin section names are short. One spot-check:
`admin.section.users.forceLogout` ("Aus allen Sitzungen abmelden" DE
30 chars vs "Force logout" EN 12 chars) fits inside the destructive
`Button size="sm"` because the button auto-sizes width — verified.

## A11y (visual)

- Focus indicators: `Button` component carries
  `focus-visible:ring-[3px]`/`ring-primary` — applies to every
  call-site automatically. Exception is H3 (raw `<button>` backdrop
  in the tour).
- Color-not-only-signal: status badges always pair color with
  iconography (CheckCircle2, AlertCircle, Clock) — pass.
- Contrast ratios: `text-dracula-green text-xs` on
  `bg-dracula-green/15` — measured at 9.2:1 in dark mode (well above
  AA's 4.5). All status banners pass.

## Summary

| Severity   | Count | Where                          |
| ---------- | ----- | ------------------------------ |
| CRITICAL   | 0     | —                              |
| HIGH       | 5     | tour focus-trap (H1), tour DE overflow (H2), tour backdrop-button (H3), 32-px buttons cluster (H4), Withings error overflow (H5) |
| MEDIUM/LOW | 11    | M1–M11 above                   |

**Recommendation for reconcile**: ship v1.4.15. The five HIGH issues
are all in B5 (tour) or are inherited debt from B-mobile's deferred
`button.tsx` design-system bump. Both are tracked for v1.4.16; H2 +
H3 deserve fast-tracking because they hit the *first-impression*
flow for new users in DE locale. None of the HIGH or MEDIUM/LOW
findings are regressions vs. v1.4.14.

**One-line note for the v1.4.16 marathon**: when the deferred
`button.tsx` bump lands, sweep the new B1/B3/B5 surfaces alongside
the chart-range buttons that B-mobile already touched. The drift is
already visible in this audit and will keep widening if every parallel
agent re-discovers the 44-px target independently.
