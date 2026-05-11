# Wave 6 — Design / UX review (v1.4.23)

## Summary

- Surfaces audited: Apple Health source badge in `<MeasurementList>` (`src/components/measurements/measurement-list.tsx`), Coach drawer settings cog + `<CoachSettingsSheet>` (`src/components/insights/coach-panel/coach-drawer.tsx` + `coach-settings-sheet.tsx`), per-message thumbs feedback (`message-thread.tsx` H7), admin coach-feedback section (`src/components/admin/coach-feedback-section.tsx` + `/admin/[section]` renderer + `section-slugs.ts` + `admin-shell.tsx` nav).
- Out of scope (no UI shipped): `/api/auth/me/devices` is API-only — no settings/admin surface yet (flag as v1.4.24 candidate); sleep-stages analytics endpoint added but no chart / panel — backend-only as W2 plan stated.
- Branch: `develop`. Compared 36 v1.4.23 commits since the v1.4.22 tag (`d71e879`).
- Findings: **1 CRITICAL · 4 HIGH · 6 MED · 5 LOW**

---

## CRITICAL

### C1 — Admin "Coach Feedback" section is unreachable from any nav surface

- Surface: `src/components/admin/admin-shell.tsx:51-110`, `src/components/admin/section-slugs.ts:18`, `src/app/admin/[section]/renderer.tsx:97-105`
- What: `coach-feedback` is registered in `ADMIN_SECTION_SLUGS` (slug exists, page renders, i18n keys present), but the slug was **never added to the `ADMIN_SECTIONS` nav array** in `admin-shell.tsx`. Result: the page only loads if an admin types `/admin/coach-feedback` directly — nothing in the sidebar or mobile strip surfaces it. The whole point of W5 H7 (let the operator answer "is the new prompt landing well?") is broken at the discovery layer.
- Why: `ADMIN_SECTIONS` is hand-maintained in parallel with `ADMIN_SECTION_SLUGS`. The slug list got the entry, the nav array did not. There's no compile-time guard that the two stay in sync (the renderer's exhaustive switch covers `coach-feedback`, but the sidebar doesn't loop over the slug list — it loops over its own array).
- Fix: (1) Add a `{ slug: "coach-feedback", titleKey: "admin.section.coach-feedback.title", icon: Sparkles }` entry between `ai-quality` and `feedback` so the two AI-quality views sit next to each other. (2) Land a tiny test in `src/components/admin/__tests__/admin-shell.test.tsx` that asserts every entry in `ADMIN_SECTION_SLUGS` has a matching `ADMIN_SECTIONS` entry — this drift class will recur every time a new section is added.

---

## HIGH

### H1 — Apple Health source badge is invisible on mobile (the only place the iOS user looks)

- Surface: `src/components/measurements/measurement-list.tsx:446-455` (desktop branch only), `:478-535` (mobile branch — no source render)
- What: The new pink Apple-Health chip only paints inside the **desktop** `<Table>` cell. The mobile card (`md:hidden`, lines 478-535) renders the type badge + value + timestamp + truncated note, but **no source indicator at all** — no chip, no icon, no text. So the audience that actually consumes Apple Health data (the user who opened HealthLog on their phone after a Withings/Apple Health sync) never sees that badge. Worst case: they look at the measurement list on mobile, can't tell which row was hand-logged vs synced, and re-enter a duplicate.
- Why: The mobile card layout was built before W5 (when only Withings + Manual + Import existed and the source distinction wasn't urgent). The v1.4.23 W5 patch added `formatMeasurementSource` and `sourceBadgeClass` but only wired them into the desktop branch.
- Fix: Add a tiny pink chip to the mobile card too — sit it inline with the timestamp line, e.g. `<span className="text-dracula-pink text-[10px]">Apple Health</span>` after the date. Or render a 12-px pink dot next to the type icon for `APPLE_HEALTH` only. Don't reuse the full `<Badge>` — the mobile card is already dense.

### H2 — Per-message thumbs hit-target is below the 36 px floor (M-CRIT for finger-on-glass)

- Surface: `src/components/insights/coach-panel/message-thread.tsx:457-483`
- What: Each thumbs button is `inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]`. With `text-[11px]` (~14 px line-height) + `py-0.5` (2 px each side) the rendered button height is ~18 px. The `<ThumbsUp className="size-3" />` icon is 12 px; the visible label "Helpful" / "Not quite" is the rest. **The whole control is roughly 18 px tall and 60-72 px wide.** That's half the iOS HIG / Material `≥36 px` minimum touch target and four times worse than the 44 px Apple recommends. On a phone you have to tap precisely or you miss; on a desktop trackpad it's fine but reads as "aside" rather than "click me". The same review (W5 M1) flagged the evidence summary for this — same footnote-density text-class problem.
- Fix: Wrap each button in a `min-h-9` (36 px) container, OR bump the button itself: `px-2 py-1.5 text-xs` + `size-3.5` icons. The visual still reads quiet because the colour stays muted-foreground until hover; just give the finger something to land on.

### H3 — `<CoachSettingsSheet>` has no loading skeleton — first open is a blank scroll-area for 200-600 ms

- Surface: `src/components/insights/coach-panel/coach-settings-sheet.tsx:64-135`
- What: The sheet mounts, kicks off `useQuery(["coach-prefs"], ...)` with `enabled: open`, and renders the form against `DEFAULT_COACH_PREFS` until `persisted` arrives. The fetch is gated to `enabled: open` (good — no overhead until the cog click), but the form **renders immediately** with the default values. So on first open the user sees: "Tone: Warm, Verbosity: Default, no excludes, evidence: off" — even if their saved value is "Concise / Detailed / sleep+steps excluded / evidence on". When the fetch resolves ~200-600 ms later, the controls visibly snap to the persisted values. That's a "ghost form" UX — the user might think they're seeing their saved settings before the snap, click Save, and overwrite their excludes back to the defaults if they're fast.
- Why: The render-phase setState pattern (lines 87-94) syncs the draft to persisted **only after** the query resolves; before that, `draft === DEFAULT_COACH_PREFS`. There's no `isFetching` skeleton.
- Fix: Either (a) gate the form body behind `if (!persisted) return <SheetSkeleton />` so the user never sees the wrong values, OR (b) disable the Save button until `persisted !== null` and add a top-of-sheet inline `<Loader2>` so the user knows the displayed values are the defaults, not their saved state. Option (a) is the cleaner mobile UX.

### H4 — Coach settings save closes the sheet without confirmation, so the user never sees "Saved"

- Surface: `src/components/insights/coach-panel/coach-settings-sheet.tsx:96-110`
- What: `save.mutate` succeeds → `onOpenChange(false)` immediately. There's no toast, no inline "Saved." moment, and the sheet just disappears. The `insights.coach.settingsSaved` key is defined ("Saved." / "Gespeichert.") but never rendered. The user clicks "Save", the sheet vanishes, and they're back in the message thread with no confirmation that anything happened. If they hit Save by accident they have no idea what just got persisted.
- Why: The `onSuccess` flow optimised for "get out of the way", but UX-wise that reads as the action being silent / dropped — especially on a slow connection where the click-to-close gap is ~400 ms and the user is unsure whether the click registered.
- Fix: Either (a) keep the sheet open + flip the Save button to a green "Saved." pill for ~1.2 s before auto-closing, OR (b) emit a short `useToast({ description: t("insights.coach.settingsSaved") })` toast on success and let the sheet close immediately. The toast pattern matches the rest of HealthLog's settings flows (notifications, integrations).

---

## MED

### M1 — Coach prefs sheet has no error state when save fails

- Surface: `src/components/insights/coach-panel/coach-settings-sheet.tsx:96-110`, `:271-296`
- What: `save.isError` is never read. If the PUT 4xx/5xxs (validation, network, rate-limit), the sheet stays open with no banner — the user clicks Save again, gets the same silent failure, and eventually closes the sheet thinking they saved. The `coachPrefs` Zod schema rejects invalid `excludeMetrics` shapes and the route can return 422; that error never reaches the user.
- Fix: Add `{save.isError && <p role="alert" className="text-destructive text-xs">{t("insights.coach.settingsError")}</p>}` above the footer button row, wire two new translation keys.

### M2 — Per-message thumbs feedback has no streaming-state guard at the UI level (relies on `messageId == null`)

- Surface: `src/components/insights/coach-panel/message-thread.tsx:401-410`
- What: The thumbs render is gated on `messageId && !inProgress && !errorCode && providerType !== "refusal"`. The `messageId` check works for _streaming_ bubbles (the in-flight bubble has no id until the SSE `done` event resolves the persisted twin), but the 150 ms grace-window logic (the `suppressedTwinId` from W5 reconcile) means the **persisted twin paints with an `id` set** — so if a user is fast enough they could thumbs-rate a message that's still mid-stream visually because the persisted bubble landed. Low likelihood, but the rating would be on a message the user can't yet read in full.
- Fix: Add a `streaming?.messageId === messageId && streaming?.inProgress` early-return in `CoachMessageFeedback`, OR pass a `streamingActive` prop down so the thumbs row only mounts after the streaming state fully clears.

### M3 — Admin Coach-Feedback table: `tone` and `verbosity` cells render the raw enum string

- Surface: `src/components/admin/coach-feedback-section.tsx:166-167`
- What: `<td>{bucket.tone}</td>` / `<td>{bucket.verbosity}</td>` print the literal API enum (`warm` / `neutral` / `concise`, `brief` / `default` / `detailed`) — same anti-pattern v1.4.20 M4 + W5 M3 flagged for severity badges (uppercase enum → translated label). The user-facing settings sheet _does_ translate these correctly via `insights.coach.settingsToneWarm` etc.; the admin table doesn't reuse those keys. German operators see "warm" / "concise" rather than "Warm" / "Knapp", and the column cells become an inconsistency on the page (column headers translated, cells English-only enum).
- Fix: Build a small lookup `t(\`insights.coach.settingsTone${capitalize(bucket.tone)}\`)`. Or (cleaner) add a dedicated `admin.coachFeedback.tone.warm` set so the admin context owns its labels.

### M4 — Admin Coach-Feedback table has no severity / colour bands on `helpfulRate` for n<10

- Surface: `src/components/admin/coach-feedback-section.tsx:47-51`, `:155-181`
- What: `helpfulRateColour` returns red / amber / green based purely on the rate, ignoring sample size. A bucket with 1 helpful + 0 unhelpful (n=1, rate=100%) renders bright `text-dracula-green`, looking like a strong positive signal — but it's noise. Similarly 0/3 paints `text-dracula-orange` like a real warning. The W5 H7 plan called out that the operator's first useful question is "did the new prompt-version land well", which needs the n column to be **the** primary signal, not the rate colour.
- Fix: Either (a) only colour-band when `total >= 20` (mirrors the v1.4.23 Pearson-surfacing gate at `n>=20` from commit `1faee95`), OR (b) render a faint `text-muted-foreground` rate when `total < 10` and switch to the colour-band only above that threshold. Bonus: italicise or mark `n<10` rows with a "low confidence" sub-row so the operator's eye skips past them.

### M5 — Admin Coach-Feedback has no sort, no filter, no time-window picker

- Surface: `src/components/admin/coach-feedback-section.tsx:127-185`
- What: The table is a flat 7-column list of every (promptVersion × tone × verbosity) bucket the aggregator emits. With 3 prompt versions × 3 tones × 3 verbosities = up to 27 rows; with version sprawl over time that becomes 50+. There's no sort (descending-by-`total` would be the natural default — show the most-rated combinations first); no filter (operator can't isolate "show me only the new prompt-version"); no time-window picker (window is hard-coded to whatever the aggregator emits). For the v1.4.23 question of "did the warm tone overshoot?" the operator has to eyeball-scan a 27-row table.
- Fix: Phase-2 punt is fine, but document it. v1.4.24 should add (a) sort by total / helpful-rate, (b) prompt-version filter chips at the top of the section, (c) re-use the AI-Quality section's window picker if it has one.

### M6 — Coach drawer header now stacks 4 controls in a row that's tight at 375px

- Surface: `src/components/insights/coach-panel/coach-drawer.tsx:239-281`
- What: Header row contains: avatar (32 px) + title-block (flex-1, min-w-0) + "+ New chat" button (text label hides on `<sm`) + 32-px settings cog + Sheet close-X (~32 px). On a 375 px viewport with the drawer at full width, the available row width is ~327 px (375 - 48 padding). Avatar + cog + close-X = 96 px of fixed widget; the title-block gets ~230 px and the new-chat icon-only takes 36 px. That works for a typical conversation title ("Mein Blutdruckverlauf") but truncates aggressively for the German default ("Neue Unterhaltung") + a long auto-generated title. The settings cog at `size-8` (32 px) with a `size-3.5` icon (14 px) is the correct hit target, but the header reads visually crowded.
- Fix: Either (a) push the settings cog into a kebab `<DropdownMenu>` on `<sm` (one trigger, two items: "New chat" + "Settings"), OR (b) drop the avatar on `<sm` since the gradient-sparkles is just decoration there — the title carries the meaning.

---

## LOW

### L1 — `feedbackUnhelpful` copy: "Not quite" / "Nicht ganz" reads soft to the point of sounding evasive

- `messages/en.json:924`, `messages/de.json:924`. The DE/EN pair is consistent, but both strings dodge the "this wasn't helpful" affordance. Compare to the EN/DE "Helpful" / "Hilfreich" which lands directly. Consider "Not helpful" / "Nicht hilfreich" — symmetric, direct, and matches the admin-table column header "Not helpful" / "Nicht hilfreich" (already translated cleanly there). Mismatched user-facing vs admin-side label is a footgun for the prompt-tuning loop ("the user clicks 'not quite', the dashboard says 'not helpful', operator wonders if these are the same signal").

### L2 — `coach-prefs-evidence` Switch + Label flex-row layout breaks alignment when the hint wraps to 3 lines

- `src/components/insights/coach-panel/coach-settings-sheet.tsx:245-268`. The `flex items-start justify-between` puts the Switch flush-right against the label column. On a 375 px sheet the German hint ("Die Belege-Box unter jeder Antwort automatisch öffnen.") wraps to 2 lines, sometimes 3 with Reading-Mode font scaling — the Switch sits at the top of the column and the label visually disconnects from its control. Consider `items-center` (the Switch tracks the label's vertical centre) or move the Switch to a row-below position when the hint exceeds one line.

### L3 — Coach prefs `<Sheet>` description prose includes a casual second-person colloquialism in DE

- `messages/de.json:907`: "Stell ein, wie der Coach mit dir spricht." reads conversational ("Stell ein" is informal imperative). The rest of the settings UI uses indicative prose ("Die Belege-Box ... öffnen.", "Der Coach sieht keine Daten ..."). Consider "So spricht der Coach mit dir." (descriptive) or "Hier kannst du anpassen, wie der Coach mit dir spricht." (indicative). The Marc voice is professional / English-default; the imperative DE here breaks that.

### L4 — Admin Coach-Feedback section uses raw `<table>` not the shadcn `<Table>` primitive

- `src/components/admin/coach-feedback-section.tsx:127-185`. Every other admin table (`<Table>` from `@/components/ui/table`) carries the same row-hover, border, and cell-padding tokens. This section reaches for raw `<table className="w-full text-sm">` and re-implements the styling inline (`border-b border-border/40`, etc.). Not broken, but inconsistent — and a maintenance trap when the next shadcn token sweep updates the `<Table>` primitive but skips this hand-rolled one.
- Fix: Swap to `<Table>` / `<TableHeader>` / `<TableRow>` / `<TableHead>` / `<TableCell>` so the section inherits the rest of the admin UI's table token bleed.

### L5 — Apple Health source-badge contrast: `bg-dracula-pink/15 text-dracula-pink` on the dracula `--background` is borderline

- `src/components/measurements/measurement-list.tsx:131-134`. `--dracula-pink: #ff79c6` on `--background` (Dracula dark, ~#282a36) hits 5.7:1 contrast — passes WCAG AA for normal text but the chip is `text-xs` (12 px), and the `bg-dracula-pink/15` overlay further reduces effective contrast against the surrounding card. Test in Chrome's "vision deficiencies" simulator (deuteranopia + tritanopia) — the pink reads as dim grey-pink. Consider `text-dracula-pink` paired with `bg-transparent border border-dracula-pink/40` so the colour is on the chip border + label, not the fill — better contrast at small text sizes and matches the lighter weight of the desktop table cell.

---

## Things done particularly well

1. **Coach prefs sheet schema discipline.** Tone, verbosity, excludeMetrics, showEvidenceByDefault — all four match the W5 H4 spec exactly, and the sheet body is a single 4-control vertical scroll with no nested tabs / accordions / sub-pages. Reads as a calm "twiddle four knobs and save" surface, exactly the right shape for a feature 80 % of users won't open. The `data-slot` discipline (every interactive element has a stable `coach-prefs-*` slot for E2E targeting) is the kind of test-affordance that scales — Playwright never has to selector-guess.

2. **Disclaimer redundancy at message-thread bottom is the right safety call.** The W5 reconcile fix to pin the disclaimer at the message-thread bottom (`message-thread.tsx:211-225`) closes the v1.4.22 H3 medical-safety regression cleanly — every Coach session carries the disclaimer regardless of viewport now, and the desktop sources-rail copy stays as a secondary anchor. The "redundancy is intentional for clinical-adjacent UI" comment is the kind of forward-defence the next contributor will thank you for.

3. **Apple Health pink chip's brand token choice.** Picking `dracula-pink` (the closest Dracula token to Apple's iOS health red) for the badge is the right cross-brand grace note — the chip reads "Apple Health" without breaking the Dracula palette discipline. Just need to extend the chip to mobile (H1) for the win to land.

---

## Design decisions worth pushing back on

1. **Settings cog comes back as a Sheet — but the v1.4.22 reflection said "consider whether the right replacement is _not_ a cog: per-message 'thinking style' controls or a one-time onboarding".** v1.4.23 H4 reflexively re-added the cog the v1.4.22 B5 audit removed. The Sheet-with-4-controls is well-built, but it's a **global preference panel that 95 % of users never open** — exactly the shape v1.4.22's reflection warned against. Per-message tone toggles ("Try this in 'Concise' mode" pill at the bottom of an unhelpful Coach reply) would flow naturally from the H7 thumbs feedback you just shipped — a thumbs-down could surface a "try the same question with shorter / drier tone?" inline action. That's the iteration loop the differentiator-as-AI-coach memory ([feedback_ai_insights_differentiator]) wants. The cog stays as a power-user fallback, but it shouldn't be the primary surface.

2. **Per-message thumbs landed without a "why" follow-up.** The v1.4.23 H7 implementation captures rating but no qualitative signal. Helpful-rate aggregates are useful for "is this version landing", but the question that informs the next prompt iteration is "what made this unhelpful — wrong, vague, too-warm, missed-context?". Even a 4-chip follow-up after thumbs-down ("incorrect / too long / wrong tone / missed something") would 10x the operator's prompt-tuning signal. v1.4.24 candidate, but flag the gap before the aggregator telemetry calcifies the current shape.

3. **Sleep-stage analytics + `/api/auth/me/devices` shipped backend-only.** Both endpoints are live, both have integration coverage, neither has a UI surface. That's the right velocity call (iOS app is the consumer for both), but worth documenting in the v1.4.24 plan as "UI surface follow-up: web devices view + sleep-stage breakdown panel". A user on web who connects Apple Health right now will see the new pink chip on imported measurements but have no way to see sleep stages or manage which iPhone owns which APNs token. That's a "we shipped infra but not the user-visible payoff" gap that erodes user trust in releases that look big in CHANGELOG.md but reveal nothing new in the UI.
