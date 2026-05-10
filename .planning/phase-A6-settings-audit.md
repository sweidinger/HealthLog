# Settings mobile audit (Pixel 5, 393×851)

Captured against production `https://healthlog.bombeck.io` on
2026-05-10 with Marc's session cookie. Screenshots in
`/tmp/healthlog-a6/before/<route>-tall.png`. Geometry tables produced
by `scripts/audit-a6-v2.mjs`.

## Routes covered

| Route                     | Purpose                             |
| ------------------------- | ----------------------------------- |
| `/settings/account`       | profile + password + passkey + tour |
| `/settings/dashboard`     | tile/chart layout + comparison      |
| `/settings/ai`            | provider config + fallback chain    |
| `/settings/notifications` | telegram + ntfy + web-push + status |
| `/settings/export`        | doctor report + CSV/JSON            |

## Inconsistency table

### Input heights

| Section       | Element                             | Actual | Expected |
| ------------- | ----------------------------------- | -----: | -------: |
| account       | Username `<Input>`                  |     36 |       36 |
| account       | Email `<Input>`                     |     36 |       36 |
| account       | Gender native `<select>`            |     36 |       36 |
| account       | Height `<Input type=number>`        |     36 |       36 |
| account       | Date of birth `<Input type=date>`   |     36 |       36 |
| account       | Language native `<select>`          |     36 |       36 |
| ai            | "Active provider" native `<select>` | **40** |       36 |
| ai            | "Add provider" native `<select>`    | **32** |       36 |
| dashboard     | "Compare to" `<SelectTrigger>`      | **44** |       36 |
| export        | All date `<Input>` fields           |     36 |       36 |
| notifications | All telegram + ntfy `<Input>`       |     36 |       36 |

The account section is internally consistent at 36 px. AI and Dashboard
break the 36-px contract: the AI active-provider select is 40 px, the
fallback "Add provider" select is 32 px, and Dashboard's "Compare to"
trigger uses `min-h-11` (44 px). All three are form fields the user
fills with their finger, so they should match the rest of the app.

### Action-button placement

| Section       | Button                          | Placement on mobile      | Overflow?                         |
| ------------- | ------------------------------- | ------------------------ | --------------------------------- |
| account       | Save (profile)                  | bottom of form, right    | no                                |
| account       | Add passkey                     | bottom of card, right    | no                                |
| account       | **Change password**             | inline next to title     | borderline (336 / 361)            |
| account       | **Restart onboarding tour**     | inline next to title     | **YES — overflows card by 48 px** |
| ai            | Disconnect                      | full block, sm           | no                                |
| dashboard     | Reset to defaults               | inline next to title, sm | no                                |
| export        | Configure & generate / Download | bottom of card, sm       | no                                |
| notifications | Send test (status card)         | inline                   | no                                |

Critical bug: on a 393-px viewport the "Restart onboarding tour" button
overflows the right edge of its parent card by ~48 px. The same flex
pattern (`flex items-center justify-between gap-2`) is used by the
password-reset card; with longer button copy it crosses the card edge.

### Spacing inconsistencies

| Section       | Section-level spacing | Card-internal spacing                         |
| ------------- | --------------------- | --------------------------------------------- |
| account       | `space-y-6`           | `space-y-4` (form), `space-y-2` (field group) |
| dashboard     | `space-y-6`           | `space-y-5` (card), `space-y-2` (field group) |
| ai            | `space-y-6`           | `space-y-6` (card), `space-y-3` (sub-card)    |
| notifications | `space-y-6`           | per-card varies                               |
| export        | `space-y-6`           | `gap-3` grid + `mt-3 space-y-3` (card)        |

The `space-y-6` outer rhythm is consistent; the card-internal rhythm
varies between `space-y-3` / `space-y-4` / `space-y-5`. Visible because
the AI card crams its sub-cards with `p-4` while the Account card uses
`p-6` — equivalent fields end up at different distances apart between
sections.

### Sprache-Menü specifics

The Sprache (language) `<select>` lives in the same row as the date-of-
birth field on the Account → Profile form. Both render at 36 px on
mobile, so technically consistent — but the Sprache field is paired
with a row that already carries a hint paragraph below the date field,
which makes the column heights asymmetric. On `<sm` the grid collapses
to a single column so the visual order becomes:

date-of-birth → date-hint → language → language-hint

That ordering is fine, but the Language field is the only locale switch
in the entire settings shell. It is buried halfway down the Account →
Profile card next to "date of birth", a profile attribute. Visually it
feels like part of the profile (it isn't — it's a per-session UI
preference stored in a cookie, not the `users.locale` column).

### Dashboard "Compare to"

Renders at 44 px (`min-h-11`) which mismatches the 36-px input contract
elsewhere. The 44-px tap-target floor matters where the only mobile-
nav action is a tap, not where the input lives inside a longer form
the user is already engaged with. Bring it down to 36 px on `>=sm`.

## Decisions

1. **Standardise input height to 36 px** (`h-9`). Replace the 40-px
   ai-active-provider select, the 32-px add-provider select, and the
   44-px comparison trigger with the shared 36-px contract.
2. **Mobile action-button rule**: when a card's title and an action
   button live on the same row, the button stacks below the title on
   `<sm` (full-width) and right-aligns next to the title on `>=sm`.
   Prevents the "Restart onboarding tour" overflow.
3. **Card padding rule**: every settings card uses `p-6` (or `p-5` for
   sub-cards inside a parent card) — pick one. Settled on `p-6` for
   top-level cards. The AI sub-card uses `p-4` which matches its
   nested role; left as-is.
4. **Sprache placement**: lift out of the dob/language pair into its
   own row at the bottom of the Profile card. Keeps copy as-is, but
   stops implying language is a profile attribute.
5. **Spacing**: top-level section uses `space-y-6`. Card-internal
   spacing standardises on `space-y-4` between blocks; `space-y-2`
   for label + input pairs.
