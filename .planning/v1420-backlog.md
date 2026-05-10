# v1.4.20 backlog — A8 deferred MED + LOW

Source: `.planning/phase-A8-quality-findings.md` (78 findings).
v1.4.19 Wave B applied 6/6 CRIT and 21/25 HIGH; this file is
the carry-over.

The strategic Insights redesign + AI Coach is the v1.4.20
headline. Pick winners from the list below before / after that
work — most of these are 1–3 lines of i18n or a single
component edit.

## HIGH deferred (4)

- **F-12** — User-management mobile cards, 5 icon buttons
  (`src/components/admin/user-management-section.tsx`). Spot
  check during Wave B showed every icon button already carries
  `aria-label` + `title` (edit, reset password, force logout,
  role change). Treat as *not-an-issue*; revisit only if a
  concrete a11y audit re-flags it.
- **F-14** — Settings/Integrations status duplicated. Already
  shipped under v1.4.19 A5; keep an eye out for regressions but
  no new work here.
- **F-23** — Mood / Achievements DE strings. Spot check showed
  every mood label (`mood.levelLausig` … `mood.moodLabel5`,
  `mood.moodAwful` … `mood.moodGreat`) is translated in
  `messages/de.json`. The achievement-subtitle awkwardness was
  fixed by F-27. Treat as *not-an-issue*; revisit only with a
  fresh DE-locale screen-by-screen pass.
- **F-26** — Insights regenerate banner / refresh button conflict.
  Already partially in A3 scope (page-level Regenerate,
  per-recommendation Regenerate). The banner button copy was
  fixed in F-06. Per-tile refresh icons removal is a v1.4.20
  Insights-redesign concern.

## MEDIUM (31)

### Layout / spacing

- **F-32** — `/settings/dashboard` triple help blocks
  (subtitle + card help + "Adds a dimmed prior-period overlay…").
  `messages/*.json:settings.sections.dashboard.description`
  + `dashboardLayout.compareCallout`. **S**.
- **F-39** — `/settings/dashboard` column heads `TILE` / `CHART`
  in uppercase (`src/components/settings/dashboard-layout-section.tsx`).
  Sentence-case to match the rest of the app. **S**.
- **F-57** — Mobile settings tab strip clips `Notificat…` with
  no scroll affordance (`src/app/settings/[section]/page.tsx`,
  the inline pill strip). Add a right-edge fade gradient or a
  chevron. **M**.

### Copy nits

- **F-33** — `/mood` subtitle "Mood tracker & entries" — drop
  ampersand + redundant words.
  `messages/*.json:mood.subtitle`. **S**.
- **F-34** — `/measurements` subtitle "Weight, blood pressure,
  pulse & more" — replace `&` with `and` / `und`.
  `messages/*.json:measurements.subtitle`. **S**.
- **F-35** — Send-test button label "Send test" vs "Test
  message". `messages/*.json:settings.telegramTest`,
  `settings.notificationStatus.sendTest`. **S**.
- **F-36** — Status-word inconsistency "Connected / Running /
  Active / Configured" across system-status / integrations /
  notifications. Reduce to two words: `Healthy` / `Disabled` /
  `Error`. **M**.
- **F-37** — Form labels with trailing colon ("Username:" vs
  "Default language") — sweep across every settings page,
  pick the no-colon variant. **M**.
- **F-38** — `/settings/thresholds` "Auto:" pseudo-label
  trailing colon. `src/components/settings/thresholds-editor-section.tsx`,
  `messages/*.json:thresholds.autoModeLabel`. **S**.
- **F-44** — `/admin/app-logs` references env var `LOKI_ENDPOINT`
  to end-users. `messages/*.json:admin.appLogs.workerHint`. **S**.
- **F-45** — `/admin/users` first column header is "Users"
  (the user-name column) — should be "Name" or "User".
  `src/components/admin/user-management-section.tsx` table head.
  Date format already covered by F-04. **S**.
- **F-46** — `/admin/backups` upload help "JSON file matching
  the current backup schema. Max 10 MB." is a sentence fragment.
  `messages/*.json:admin.section.backups.uploadHelp`. **S**.
- **F-47** — `/notifications` (per-event rules) and
  `/settings/notifications` (channels) share H1 "Notifications".
  Rename one to "Notification rules", the other to
  "Notification channels". **S**.
- **F-48** — `/insights` "AI Health Analysis" + "Personal advisor"
  subtitle redundant. Drop the "Personal advisor" subtitle —
  but coordinate with v1.4.20 Insights redesign first. **S**.
- **F-49** — Decimal separator inconsistent on DE locale
  (`88.6 kg` vs `88,6 kg`). Sweep `value.toFixed(1)` patterns,
  replace with `fmt.number()` /
  `Intl.NumberFormat(locale).format()`. **M**.
- **F-50** — DE error-toast tone: 6 instances of
  `Bitte erneut versuchen` (impersonal infinitive) vs the
  HealthLog-standard personal `Bitte versuche es erneut`.
  `messages/de.json:746, 937–940, 1172, 1222`. **S**.
- **F-51** — `/settings/account` DOB hint "Used for automatic
  blood pressure target calculations" vs Gender hint "Used for
  gender-specific target values" — pick one phrasing.
  `messages/*.json:settings.dateOfBirthHint`,
  `settings.genderHint`. **S**.
- **F-53** — `/settings/ai` subtitle "Provider, model, key." is
  a noun list, not a sentence. `messages/*.json:settings.sections.ai.description`. **S**.
- **F-54** — `/settings/ai` mixes "Codex", "ChatGPT", "OpenAI" —
  pick one user-facing brand. **S** (i18n) but with
  cross-component consequences.
- **F-55** — `/settings/export` "Configure & generate" CTA uses
  ampersand. `messages/*.json:settings.sections.export.cta`. **S**.
- **F-56** — `/settings/advanced` subtitle says "danger zone"
  but card title is "Delete All Data". Rename section header to
  "Reset account data" / "Daten zurücksetzen" so the user-side
  surface is distinct from admin Danger Zone.
  `messages/*.json:settings.sections.advanced.title`. **S**.
- **F-58** — `/admin/reminders` "Run reminder check" button uses
  wave/chart icon — change to `RotateCw` / `Clock` icon.
  `src/components/admin/reminders-section.tsx`. **S**.
- **F-62** — Mobile dashboard greeting "Hello Marc, welcome
  back." in EN vs DE. Spot-check whether DE bundle renders;
  fall-back-to-EN when missing was already audited.
  `messages/*.json:dashboard.greeting`,
  `dashboard.greetingSubtitle`. **S**.

### Typography / mobile / icons

- **F-40** — Compliance bars on medication card uniform purple
  regardless of % value. Threshold-coloured fill (≥80 % green,
  50–80 % yellow, <50 % red).
  `src/components/medications/medication-card.tsx` Progress. **S**.
- **F-41** — Targets page label inconsistency
  ("Normal", "Optimal", "Moderate", "On target"). Already
  partly covered by A7. Standardise to a small set:
  `Optimal` / `On target` / `Watch` / `Off target`.
  `src/app/targets/page.tsx`. **S**.
- **F-42** — `/auth/login` mobile vertical centering + missing
  app subtitle ("Sign in to your HealthLog account."). **S**.
- **F-43** — `/admin/api-tokens` "Collapse" / "Einklappen" already
  removed by A7; F-43 also flags `/admin/login-overview` —
  same pattern, single-card page, drop the toggle.
  `src/components/admin/login-overview-section.tsx`
  `expanded` toggle + `setExpanded`. **S**.
- **F-59** — Mood entries show numeric score `2 (Bad)` /
  `3 (Okay)` — paren label feels debug-y. Switch to coloured
  1-5 badge + descriptor.
  `src/components/mood/mood-list.tsx`. **S**.
- **F-60** — Comment column shows `-` (hyphen) instead of empty
  cell or em-dash. `src/components/measurements/measurement-list.tsx`,
  `src/components/mood/mood-list.tsx`. **S**.
- **F-61** — Empty IP / Location columns on /admin/login-overview
  always render `—`. Hide columns when no rows have the field
  populated. `src/components/admin/login-overview-section.tsx`. **M**.

## LOW (16)

- **F-63** — `/auth/login` divider "or" — keep as-is or
  "Or sign in with password". **S**.
- **F-64** — Achievement card "Idiot" / "Lazy Boy" badges share
  a sparkle icon. (Titles already fixed via F-03; pick distinct
  icons next pass.) `src/components/achievements/*`. **S**.
- **F-65** — Targets page card-icons mixed colors (purple scale,
  pink heart, green pulse) — pick a single muted Dracula
  palette. `src/app/targets/page.tsx`. **S**.
- **F-66** — Withings card "Save credentials" button stays
  grey/muted; user doesn't know it's clickable. Make it
  `disabled` until dirty, primary purple when dirty.
  `src/components/settings/withings-section.tsx`. **S**.
- **F-67** — Sort indicators inconsistent on /measurements
  table headers (some `↕`, Date shows `↓`). Render a single
  arrow that flips on toggle.
  `src/components/measurements/measurement-list.tsx` table
  header. **S**.
- **F-68** — `/medications` button "Skipped" visually almost as
  prominent as "Taken". Demote to ghost / secondary.
  `src/components/medications/medication-card.tsx`. **S**.
- **F-69** — Achievements card "Next goal" inline format —
  "Progress to unlock: 166 / 200 (83%)" then "320 points" on a
  separate line. Inline both. `src/components/achievements/*`. **S**.
- **F-70** — `/settings/integrations` Withings client-id
  placeholder gets truncated mid-word at 1280 px desktop. Use a
  shorter "Already saved".
  `messages/*.json:settings.withingsCredentialsSavedPlaceholder`. **S**.
- **F-71** — `/insights` "Generated 57 minutes ago" — pick one
  convention (relative for recent, absolute on hover). **S**.
- **F-72** — Bare Next.js 404 ("This page could not be found.")
  with no nav. Add custom `app/not-found.tsx` with logo +
  "Back to dashboard" CTA. **S**.
- **F-73** — Onboarding subtitle + footer say the same thing
  ("Skip this step — you can finish setup later from
  Settings."). Drop one. `src/app/onboarding/page.tsx`. **S**.
- **F-74** — `/settings/account` DOB hint mentions only blood
  pressure but BP target also uses gender — hoist explanation
  to section level. Already overlaps with F-51. **S**.
- **F-75** — `/insights` "Based on your last 90 days" doesn't
  update with the active range tab. Tie the message to the
  selected range.
  `src/components/insights/insight-advisor-card.tsx`. **M**.
- **F-76** — `/admin/system-status` cards "Last Reminder Check"
  inconsistent capitalisation. Sentence-case throughout.
  `messages/*.json:admin.section.system-status.*`. **S**.
- **F-77** — `/admin/api-tokens` "Last used: Never" /
  "Created: 05/05/2026" colon style + date format. Already
  covered by F-04 (date format) and F-37 (colon style). **S**.
- **F-78** — `/settings/account` "Profile" sub-card heading
  repeats page-level "Account" framing — drop the inner
  heading. `src/components/settings/account-section.tsx`. **S**.

## Notes for v1.4.20 picks

- The MED block is dominated by copy nits — running prettier
  + a single i18n sweep would land 12+ of them in one commit.
- F-36 (status-word taxonomy) is a small refactor that pays
  off everywhere; consider doing it before the Insights
  redesign so the new surface inherits the canonical
  vocabulary.
- F-49 (decimal separator) wants a codemod or grep sweep,
  not hand-edits — touches many tile components.
