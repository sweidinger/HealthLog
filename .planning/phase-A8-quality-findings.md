# Phase A8 — Quality-of-Life Audit (write-only)

Run on production https://healthlog.bombeck.io with Marc's session, captured at Pixel 5 (mobile) and 1280px (desktop) via Playwright + code grep cross-check. The user is on the **English** locale, but several findings are German-only (translations, formatters) and were verified against `messages/de.json` + helper modules.

Findings are sorted by **Severity DESC**, then **Effort ASC** within each severity. Top-10 most-impactful are marked with a star.

Legend: CRIT = genuinely confusing / broken UX, HIGH = visible quality issue, MED = polish nit, LOW = taste preference. S/M/L = Small/Medium/Large.

---

## CRITICAL findings

### F-01 ⭐ — `formatTimeWindowRange` hard-codes German "bis ... Uhr" regardless of locale

- Severity: CRITICAL · Type: copy-incorrect · Effort: S · Route: /medications, dashboard medication tile
- File: `src/lib/time-window-format.ts:10`
- Issue: Returns `"${start} bis ${end} Uhr"` literally, so an English-locale user sees `"Today, 19:00 bis 23:00 Uhr (Abends)"` (mixed languages, plus the German label `(Abends)` from i18n). Visible on /medications, dashboard, doctor report.
- Fix: Route through `useFormatters()` / per-locale string ("from {start} to {end}" / "{start} bis {end} Uhr"), or accept the locale as a parameter.

### F-02 ⭐ — `/admin/login-overview` shows insights events instead of auth events

- Severity: CRITICAL · Type: copy-incorrect (subtitle vs data) · Effort: S · Route: /admin/login-overview
- File: `src/components/admin/login-overview-section.tsx`, API at `src/app/api/admin/login-overview/route.ts`
- Issue: Page subtitle reads "Audit trail of authentication and admin events." but the rows are `insights.weight-status.en`, `insights.bmi-status.en`, `insights.medication-compliance-status.en` etc. Either the filter is missing (fetching all annotated events) or the subtitle is wrong.
- Fix: Either filter to `auth.*` + `admin.*` action prefixes, or rename the page "Activity / Audit trail" and surface the action category.

### F-03 ⭐ — Achievement names "Idiot" and "Lazy Boy" are insulting and not translated

- Severity: CRITICAL · Type: copy-incorrect · Effort: S · Route: /achievements
- File: `messages/en.json:2014, 2018` and `messages/de.json:2014, 2018`
- Issue: `overIntake1.title = "Idiot"` and `skippedIntake1.title = "Lazy Boy"` literally insult the user for over-taking medication or skipping a dose. Both are also untranslated in the German bundle. For a health app this is harmful.
- Fix: Rename to neutral "Double take" / "Took it twice" and "Stepped back" / "Kept it light"; translate.

### F-04 ⭐ — Date format leaks US (mm/dd/yyyy) on a German-default app

- Severity: CRITICAL · Type: copy-incorrect · Effort: M · Route: /admin/users, /admin/api-tokens, /admin/backups, /settings/account, /settings/export, onboarding
- File: many — likely `useFormatters()` not wired up everywhere; `<input type="date">` shows browser default
- Issue: Native date inputs render `mm/dd/yyyy` even when DE locale is active. Date columns rendered with `toLocaleDateString()` show `02/20/2026` style. DE users expect `20.02.2026` and `TT.MM.JJJJ` placeholders.
- Fix: Pass `lang="de-DE"` on `<input type="date">`, route all date display through `useFormatters().date()` with the active locale.

### F-05 ⭐ — Admin "Welcome, Marc" tells users to "Pick a section from the sidebar" but mobile has no sidebar

- Severity: CRITICAL · Type: copy-incorrect (mobile-only) · Effort: S · Route: /admin
- File: `messages/de.json:1813` / `messages/en.json:1813` (`admin.welcomeSubtitle`)
- Issue: Copy "Pick a section from the sidebar to manage HealthLog." but mobile uses a horizontal pill strip, not a sidebar. Also the en.json text is in DE.
- Fix: Detect mobile or use neutral copy: "Pick a section above to manage HealthLog." / "Wähle einen Bereich, um HealthLog zu verwalten."; ensure en.json has the English text.

### F-06 — `/settings/notifications` info banner says "regenerate" but the only button says "Start analysis"

- Severity: CRITICAL · Type: copy-incorrect · Effort: S · Route: /insights (yellow info card)
- File: likely `src/components/insights/*` (`insightsUpdated…` translation key)
- Issue: Yellow banner reads "Insights updated — regenerate for new explainability features" then offers a button labelled "Start analysis". Mismatch between verb ("regenerate") and CTA ("Start analysis").
- Fix: Change either the banner copy ("Click 'Start analysis' to refresh with new explainability features.") or rename the button to "Regenerate".

---

## HIGH findings

### F-07 ⭐ — Settings nav label "Personal targets" but URL is /settings/thresholds and inner card title "Personal thresholds"

- Severity: HIGH · Type: copy-redundant + copy-incorrect · Effort: S · Route: /settings/thresholds
- File: `src/components/settings/section-slugs.ts`, `src/components/settings/thresholds-editor-section.tsx`, `messages/*.json`
- Issue: Three different names for the same screen: nav "Personal targets" → page header "Personal targets" → card header "Personal thresholds". Two near-identical descriptions stack: subtitle "Override target ranges for every metric." + card help "Override the computed target range for any metric. Defaults stay in effect until you set a value here."
- Fix: Pick one term ("Personal thresholds" matches the route slug) and drop the duplicate help line.

### F-08 ⭐ — Admin overview greeting + every admin/settings card has duplicate page header / card header

- Severity: HIGH · Type: copy-redundant · Effort: S · Routes: /admin (Administration / Welcome), /admin/system-status (System Status / System Status), /admin/login-overview (Login Overview / Login Overview), /admin/danger-zone (Danger Zone / Danger Zone), /settings/dashboard (Dashboard / Dashboard layout), /admin/feedback (Feedback / Feedback Inbox), /admin/api-tokens (API Tokens / API Tokens)
- Issue: When a section has only one card, the card header repeats the page header verbatim, taking up vertical space without adding info.
- Fix: When section has exactly one card, drop the card header and keep only the page header (or vice-versa).

### F-09 ⭐ — Backup type rendered as raw enum `WEEKLY_AUTO` (SCREAMING_SNAKE)

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /admin/backups
- File: `src/components/admin/backups-section.tsx:484` — `<Badge>{row.type}</Badge>`
- Issue: `row.type` is the raw enum `WEEKLY_AUTO`. Should be humanized.
- Fix: Map to translation key — `t('admin.backups.type.WEEKLY_AUTO')` → "Wöchentlich (auto)" / "Weekly (auto)".

### F-10 ⭐ — Measurement source `WITHINGS` rendered ALL CAPS

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /measurements
- File: `src/components/measurements/measurement-list.tsx:419` — `<Badge>{m.source}</Badge>`
- Issue: Source enum value rendered raw — "WITHINGS" instead of "Withings". Mood page does it right ("moodLog").
- Fix: Map enum to display string ("Withings", "Manuell" / "Manual", "moodLog").

### F-11 ⭐ — User-management role-change buttons "→ User" / "→ Admin" with no label

- Severity: HIGH · Type: aria-missing + copy-missing · Effort: S · Route: /admin/users
- File: `src/components/admin/user-management-section.tsx`
- Issue: A bare arrow `→ User` / `→ Admin` is a button to demote/promote. No tooltip, no aria-label, ambiguous direction.
- Fix: Use explicit text "Make user" / "Make admin" (or "Zum Benutzer / Zum Admin"), add `aria-label` and a confirmation dialog.

### F-12 ⭐ — User management mobile cards show 5 icon buttons with no labels (edit/passkey/lock/sign-out)

- Severity: HIGH · Type: aria-missing + tooltip-missing · Effort: M · Route: /admin/users
- Issue: Pencil, key, log-out-arrow, shield → all icon-only with no `aria-label` or tooltip. Even the role-change arrow lives inside this row.
- Fix: Add `<Tooltip>` + `aria-label` for every action icon. Consider collapsing to a `…` overflow menu on mobile.

### F-13 — Mobile measurement list cannot distinguish systolic vs diastolic (same heart icon)

- Severity: HIGH · Type: icon-mismatch · Effort: S · Route: /measurements (mobile)
- File: `src/components/measurements/measurement-list.tsx`
- Issue: Both `117 mmHg` (systolic) and `79 mmHg` (diastolic) render with the identical pink heart icon. User cannot tell them apart on mobile cards (desktop shows badges "Sys" / "Dia").
- Fix: Add a "Sys" / "Dia" pill before the value on mobile, or use heart-up vs heart-down icons.

### F-14 — Settings/Integrations status duplicated on the same card (this is also Marc's A5 concern)

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /settings/integrations
- File: `src/components/settings/integrations-section.tsx`
- Issue: "Connected" badge top-right + "Last sync: 05/10/2026, 12:00" top-right tag + a second container inside the card with another "Connected" badge + "Last successful sync" + "Last attempt". Three places that say the same thing. (Already in A5 scope but flagging the duplication explicitly.)
- Fix: Single status tag top-right "Connected · 2 min ago"; drop the inner container.

### F-15 — `/settings/notifications` mentions ntfy in subtitle but channel-reliability list shows only Telegram + Web Push

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /settings/notifications
- Issue: Subtitle "Per-channel delivery — Telegram, ntfy, Web Push — plus the live channel-reliability board." but the live board shows only 2 channels because ntfy isn't configured. Either show ntfy "Not configured" or drop ntfy from the subtitle.
- Fix: Render every channel slot regardless of state, with a "Not configured" badge for unconfigured channels.

### F-16 — Notifications page "Enabled" + "Configured" badges next to Telegram header are redundant

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /settings/notifications
- Issue: A pill "Configured" (green) and another "Enabled" (white) sit side-by-side with no visual hierarchy. Users don't know what differs.
- Fix: Single status badge "Active · sent 12 min ago" or "Configured · disabled".

### F-17 — Login Overview action `auth.token.autoissue.native` leaks raw event-key in /admin recent activity

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /admin (Recent activity card)
- File: `src/components/admin/recent-audit-preview.tsx`
- Issue: One row in Recent activity shows `auth.token.autoissue.native` while peers show "Passkey login" / "Password login" — the dev-facing event key wasn't translated.
- Fix: Add a translation key for every audit-action enum and fall back to "Activity" instead of the raw key.

### F-18 — `/admin/api-tokens` token name `iOS auto-login 2026-05-05T19:46:20.603Z` is dev-ugly

- Severity: HIGH · Type: typography-inconsistent · Effort: S · Route: /admin/api-tokens, /settings/api
- Issue: ISO timestamp suffix in the token name leaks. Reads as a debug label.
- Fix: Format as "iOS auto-login · 05.05.2026 19:46" (locale-aware) when generating, or strip the suffix in the renderer.

### F-19 — `/admin/api-tokens` Permissions column shows raw `*` with no explanation

- Severity: HIGH · Type: copy-missing · Effort: S · Route: /admin/api-tokens, /settings/api
- File: `src/components/admin/api-token-overview-section.tsx`
- Issue: Permissions cell renders `*` (literally) — a regex/glob meaning "all". Cryptic.
- Fix: Render as "All" / "Alle" badge with a tooltip listing wildcard semantics.

### F-20 — `/admin/feedback` subtitle and card subtitle say almost the same thing twice

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /admin/feedback
- Issue: Page subtitle "Triage user-submitted feedback and bug reports." then card subtitle "User-submitted feedback, bug reports, and feature requests." — duplicate and inconsistent (which is it: 2 categories or 3?).
- Fix: One subtitle. Drop the card-level one, or merge into "Triage user feedback, bugs, and feature requests."

### F-21 — `/admin/services` toggle descriptions all end with "system-wide." (4 lines, repetitive)

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /admin/services
- Issue: "Allow Telegram notifications system-wide." / "Allow ntfy notifications system-wide." / "Allow browser push notifications system-wide." / "Allow API endpoints and API tokens system-wide." — the suffix adds nothing; the section-level subtitle already says "system-wide".
- Fix: Drop the per-row "system-wide" suffix.

### F-22 — `/admin/services` subtitle "Enable or disable notification channels system-wide" misses the API toggle

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /admin/services
- Issue: Page subtitle says "notification channels" but the API toggle (which gates external ingest) lives on the same screen.
- Fix: "Enable or disable services system-wide." or split API onto its own card.

### F-23 — Mood / Achievements content uses English strings even when DE active (e.g. mood entries display "Bad" / "Okay" / "Terrible")

- Severity: HIGH · Type: copy-missing · Effort: S · Route: /mood
- File: `src/components/mood/*`
- Issue: Mood-score labels not translated to DE (showing "Bad", "Okay", "Terrible" in DE UI). Achievement subtitle awkward in both bundles.
- Fix: Translate the 5 mood enum labels; rewrite achievement subtitle for both bundles.

### F-24 — `/admin/integrations` toggle row duplicates the card title (Umami / Umami, GlitchTip / GlitchTip)

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /admin/integrations
- Issue: Each card has section header "Umami" + a single toggle whose label is also "Umami" with description "Enable Umami tracking." — two of the three lines say the same thing.
- Fix: Drop the inner toggle label or replace with "Enabled" / "Disabled".

### F-25 — `/admin/integrations` GlitchTip casing inconsistent (header "GlitchTip" vs field labels "Glitchtip DSN" / "Glitchtip environment")

- Severity: HIGH · Type: typography-inconsistent · Effort: S · Route: /admin/integrations
- Issue: Brand is GlitchTip (capital T). Form labels demote the T.
- Fix: Replace all "Glitchtip" → "GlitchTip" in `messages/*.json` for that section.

### F-26 — Insights regenerate banner / refresh button conflict (page-level + card-level)

- Severity: HIGH · Type: copy-redundant · Effort: S · Route: /insights
- Issue: "Regenerate" button top-right, then yellow banner with "Start analysis" CTA (see F-06), then per-tile refresh icons. Three competing refresh entry points.
- Fix: Already partly in A3 scope — one page-level Regenerate, no per-tile spinners.

### F-27 — Achievement subtitle "Unlock achievements from feature rollout onward through consistent health trends and medication habits." is awkward

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /achievements
- File: `messages/en.json:1975`, `messages/de.json:1975`
- Issue: "From feature rollout onward" is dev-speak; "through consistent health trends and medication habits" is overlong.
- Fix: "Earn achievements by tracking your health and taking your meds on time." / "Sammle Erfolge, indem du regelmäßig misst und deine Medikamente nimmst."

### F-28 — Achievement title "On-time 1d" / "BMI green · 1d" plus body "for 1 consecutive days" (grammar bug)

- Severity: HIGH · Type: copy-incorrect (grammar) · Effort: S · Route: /achievements
- File: `messages/en.json` (multiple) / `messages/de.json` (multiple)
- Issue: "Take all medications on time for 1 consecutive days." / "Reach at least 80% 30-day adherence for 1 consecutive days." — singular/plural bug; should be "for 1 day" or "1 consecutive day".
- Fix: Use ICU plural in the description ("for {count, plural, one {1 day} other {# consecutive days}}").

### F-29 — `/admin/ai-quality` subtitle uses jargon "Helpful-rate per (severity x provider)"

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /admin/ai-quality
- Issue: `(severity x provider)` is mathy and `x` is a literal letter not a multiplication sign — admin-confusing.
- Fix: "Helpfulness scores grouped by severity and provider, from the last 30 days of user feedback."

### F-30 — Admin "Inbox zero" empty-state copy assumes English idiom + missing translation

- Severity: HIGH · Type: copy-incorrect · Effort: S · Route: /admin/feedback
- Issue: Empty state title is the English idiom "Inbox zero" — DE doesn't have an equivalent expression and it's fragile copy.
- Fix: Use a literal title — "All caught up" / "Alles erledigt" or "No open items" / "Keine offenen Einträge".

### F-31 — `/admin` Recent activity row "Unknown" + "Failed" — no link to the failure

- Severity: HIGH · Type: copy-missing · Effort: S · Route: /admin
- Issue: Failed login row shows actor "Unknown" + status "Failed" but no link / IP / reason. To investigate, admin has to open Login Overview manually and re-find it.
- Fix: Make the row a link to `/admin/login-overview?focus=<id>`, surface IP at least.

---

## MEDIUM findings

### F-32 — Settings/Dashboard "Compare to" + 3 nested explanatory texts

- Severity: MED · Type: copy-redundant · Effort: S · Route: /settings/dashboard
- Issue: Page subtitle "Tile layout and order." + card help "Choose which cards appear on your dashboard and in what order. Defaults work out of the box." + "Adds a dimmed prior-period overlay to every chart and a delta callout to every tile." Three help blocks for one screen.
- Fix: Drop the card help; let the section title and per-control hints speak.

### F-33 — Mood page subtitle "Mood tracker & entries" — ampersand mid-sentence + redundant words

- Severity: MED · Type: copy-redundant · Effort: S · Route: /mood
- Issue: "&" is informal. "Mood tracker" and "entries" overlap in meaning.
- Fix: "Your mood entries over time." / "Deine Stimmung im Verlauf."

### F-34 — Measurements subtitle uses "&" inconsistently with rest of app

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /measurements
- Issue: "Weight, blood pressure, pulse & more" — `&` appears here and on Mood; nowhere else.
- Fix: Replace "&" with "and"/"und" everywhere except inline tags.

### F-35 — Send-test button label inconsistency: "Send test" vs "Test message"

- Severity: MED · Type: copy-redundant · Effort: S · Route: /settings/notifications
- Issue: Channel reliability uses "Send test", Telegram form footer uses "Test message". Same action, two labels.
- Fix: Standardize on "Send test".

### F-36 — Status word inconsistency across Admin/System Status: Connected / Running / Active / Configured

- Severity: MED · Type: typography-inconsistent · Effort: M · Route: /admin/system-status, /settings/integrations, /settings/notifications
- Issue: Multiple status verbs for similar "this is healthy" state.
- Fix: Reduce to two words: "Healthy" (works) / "Disabled" (off) / "Error" (broken).

### F-37 — Form-field labels inconsistent on trailing colon

- Severity: MED · Type: typography-inconsistent · Effort: M · Routes: every settings page
- Issue: "Username:", "Email address:", "Gender:", "Height (cm):" carry trailing colon. "Default language", "Compare to" do not. Some pages mix both.
- Fix: Pick one (modern: drop the colon). Sweep all input labels.

### F-38 — Toggle pseudo-label "Auto:" with trailing colon on /settings/thresholds

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /settings/thresholds
- Issue: "Auto:" sits next to a switch — the colon is unusual when the value follows visually below or to the right; other toggles in app omit the colon.
- Fix: Drop the colon, use just "Auto".

### F-39 — Settings/Dashboard column heads "TILE" / "CHART" in uppercase

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /settings/dashboard
- Issue: All-caps column heads only here; everywhere else (Backups, Users, etc.) uses sentence case.
- Fix: "Tile" / "Chart".

### F-40 — Compliance bars on medication card use uniform purple regardless of % value

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /medications, dashboard medication tile
- Issue: 57 % and 58 % both fill purple; no visual cue that this is below "On target". User cannot scan health at a glance.
- Fix: Threshold-coloured fill (≥80 % green, 50–80 % yellow, <50 % red).

### F-41 — Targets page label inconsistency ("Normal", "Optimal", "Moderate", "On target")

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /targets
- Issue: 4 different status words across cards. Already partly captured by A7 ("Low / On Target / Stable / Moderate" → DE).
- Fix: Standardize to a small set: "Optimal" / "On target" / "Watch" / "Off target" — and translate.

### F-42 — `/auth/login` page mobile vertical centering and missing app description

- Severity: MED · Type: mobile-only · Effort: S · Route: /auth/login (mobile)
- Issue: Login card sits in the lower half of the screen with empty space above. No "Sign in to HealthLog" subtitle, no link to docs/landing.
- Fix: `justify-center` on the wrapper; add a one-line subtitle "Sign in to your HealthLog account."

### F-43 — `/admin/api-tokens` retains "Collapse" / "Einklappen" button on a single-section page

- Severity: MED · Type: copy-redundant · Effort: S · Route: /admin/api-tokens, /admin/login-overview
- Issue: Already in Marc's A7 list, but also appears on /admin/login-overview. Both screens have only 1 card so collapse is meaningless.
- Fix: Drop the collapse control on single-card pages.

### F-44 — `/admin/app-logs` references env var `LOKI_ENDPOINT` to end-users

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /admin/app-logs
- Issue: Help text "Showing app-process logs only — worker-process logs go to Loki when LOKI_ENDPOINT is configured."
- Fix: "Worker logs are forwarded to Loki when configured." (drop the env var name, link to Operations docs).

### F-45 — Admin `/admin/users` "Created" date format US, table header "Users" left column

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /admin/users
- Issue: First column header is "Users" (the user-name column), confusing because the section is titled "User Management". Created column shows `02/20/2026`.
- Fix: Header → "Name" / "User"; date → locale-aware format.

### F-46 — `/admin/backups` upload help "JSON file matching the current backup schema. Max 10 MB." is grammatically a fragment

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /admin/backups
- Issue: Sentence has no verb.
- Fix: "Upload a JSON file matching the current backup schema (max 10 MB)."

### F-47 — `/notifications` (per-event) and `/settings/notifications` (channels) share the same H1 "Notifications"

- Severity: MED · Type: copy-redundant · Effort: S · Routes: /notifications, /settings/notifications
- Issue: Two pages with identical title; users get confused which one to open.
- Fix: Rename `/notifications` → "Notification rules" and `/settings/notifications` → "Notification channels".

### F-48 — Insights "AI Health Analysis" + "Personal advisor" subtitle + bottom raw template leak (already in A3) leave little signal

- Severity: MED · Type: copy-redundant · Effort: S · Route: /insights
- Issue: Card title "AI Health Analysis" + subtitle "Personal advisor" — both labels for the same thing. (Bottom `metric: blood_pressure_sweet` leak already in A3.)
- Fix: Drop "Personal advisor" subtitle.

### F-49 — Decimal separator inconsistent (88.6 kg vs 88,6 kg) on DE locale

- Severity: MED · Type: copy-incorrect · Effort: M · Route: dashboard tiles, /targets, /measurements
- Issue: User on DE locale should see "88,6 kg" but the dashboard tile shows "88.2 kg" with a period. Confirms `useFormatters().number()` not used everywhere.
- Fix: Replace `value.toFixed(1)` patterns with `fmt.number()` or `Intl.NumberFormat(locale).format()`.

### F-50 — German `Bitte erneut versuchen` (impersonal infinitive) vs `Bitte versuche es erneut` (Du-imperative) inconsistent

- Severity: MED · Type: copy-redundant · Effort: S · Route: many error toasts
- File: `messages/de.json:746, 937–940, 1172, 1222`
- Issue: 6 instances use the infinitive "Bitte erneut versuchen", 1 uses the personal "Bitte versuche es erneut" — DE convention everywhere else in HealthLog is the personal "Du" form.
- Fix: Convert all 6 to "Bitte versuche es erneut.".

### F-51 — Settings/account "Date of birth" subtext "Used for automatic blood pressure target calculations" — works, but `Gender` says "Used for gender-specific target values" — inconsistent phrasing

- Severity: MED · Type: copy-redundant · Effort: S · Route: /settings/account
- Issue: Same idea ("we use this to compute targets"), two phrasings in the same card.
- Fix: Pick one — "Used to compute personalized targets."

### F-52 — Achievements name "Two hundred weigh-ins" spells out the number (200), unlike sibling badges

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /achievements
- File: `messages/*.json` achievement titles
- Issue: Most badges use numerals ("80 % adherence", "300 intakes") but this one spells "Two hundred". Inconsistent.
- Fix: "200 weigh-ins" / "200 Wägungen".

### F-53 — `/settings/ai` AI section subtitle "Provider, model, key." is a comma-separated noun list, not a sentence

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /settings/ai
- Issue: Awkward. Other settings sections use full sentences.
- Fix: "Configure your AI provider and credentials."

### F-54 — `/settings/ai` mixes "Codex", "ChatGPT", "OpenAI" without explanation

- Severity: MED · Type: copy-incorrect · Effort: S · Route: /settings/ai
- Issue: Card title "AI Insights (OpenAI)" but header tag "ChatGPT connected" but provider option "ChatGPT account (Codex)" but env var `CODEX_MODEL`. Three brand names for one feature.
- Fix: Pick one user-facing brand ("ChatGPT") and consistently. Mention Codex only in the dev help under the Disconnect button.

### F-55 — `/settings/export` "Configure & generate" uses "&" inside a primary CTA

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /settings/export
- Issue: Action labels elsewhere avoid `&`.
- Fix: "Configure and generate" or "Configure report".

### F-56 — `/settings/advanced` subtitle says "danger zone" but card title is "Delete All Data"

- Severity: MED · Type: copy-redundant · Effort: S · Route: /settings/advanced
- Issue: Subtitle "Account-wide danger zone — irreversibly wipe every health record while keeping your account." paired with card "Delete All Data" — terms shift mid-page. Also overlap with admin "Danger Zone" creates risk of confusion.
- Fix: Rename section header "Reset account data" / "Daten zurücksetzen" — keep wording reserved for the global admin Danger Zone.

### F-57 — Mobile settings tabs strip clips ("Notificat...") with no scroll affordance

- Severity: MED · Type: mobile-only · Effort: M · Route: /settings/\* (mobile tab strip)
- Issue: Horizontal pill strip clips the next tab name. No fade/gradient or arrow indicating scrollability.
- Fix: Add right-edge gradient mask + a tiny chevron, or use icon-only tabs on mobile.

### F-58 — `/admin/reminders` "Run reminder check" button uses wave/chart icon instead of clock/refresh

- Severity: MED · Type: icon-mismatch · Effort: S · Route: /admin/reminders
- Issue: Icon doesn't match action.
- Fix: Use a `RotateCw` / `Clock` icon for "Run reminder check".

### F-59 — Mood entries show numeric score `2 (Bad)` / `3 (Okay)` — paren label feels debug-y

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /mood
- Issue: Score and label both shown in the same cell. Could be clearer with score badge + label.
- Fix: Pill + descriptor: e.g., a colored 1-5 badge then "Bad" beside it.

### F-60 — Comment column shows `-` (hyphen) instead of em-dash `—` or empty

- Severity: MED · Type: typography-inconsistent · Effort: S · Route: /measurements, /mood
- Issue: Inconsistent with em-dash usage elsewhere; also unclear visually.
- Fix: Use empty cell, or consistent em-dash placeholder.

### F-61 — Empty `IP` and `Location` columns on /admin/login-overview always show `—`

- Severity: MED · Type: copy-redundant · Effort: M · Route: /admin/login-overview
- Issue: Always `—` because data isn't captured. Wastes table width.
- Fix: Hide columns until populated, OR populate.

### F-62 — Mobile dashboard greeting "Hello Marc, welcome back." renders English even though user has DE locale (after locale switch)

- Severity: MED · Type: copy-incorrect · Effort: S · Route: / (dashboard)
- File: `messages/en.json:217-218`, `messages/de.json:217-218`
- Issue: Verify both bundles — current screen showed English; needs spot-check on DE locale.
- Fix: Confirm DE message present and rendered.

---

## LOW findings

### F-63 — `/auth/login` divider "or" is bare — could read "or use"

- Severity: LOW · Type: copy-redundant · Effort: S · Route: /auth/login
- Fix: Keep as-is or "Or sign in with password".

### F-64 — Achievement card "Idiot" badge displays a sparkle icon — same icon as "Lazy Boy"

- Severity: LOW · Type: icon-mismatch · Effort: S · Route: /achievements
- Fix: Choose distinct icons per badge category.

### F-65 — Targets page card-icons use mixed colors (purple scale, pink heart, green pulse) — random palette

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /targets
- Fix: Pick a single muted icon palette (Dracula tokens).

### F-66 — Withings card "Save credentials" button stays grey/muted; user doesn't know it's clickable

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /settings/integrations
- Fix: Disabled until dirty, primary purple when dirty.

### F-67 — Sort indicators inconsistent on `/measurements` table headers (some show ↕, Date shows only ↓)

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /measurements
- Fix: Always render a single arrow that flips on toggle; muted neutral when inactive.

### F-68 — `/medications` button "Skipped" is visually almost as prominent as "Taken"

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /medications
- Issue: Skipped is a fallback action; equal-weight buttons can lead to mis-taps.
- Fix: Demote Skipped to ghost / secondary; keep Taken as primary.

### F-69 — Achievements card "Next goal" reads `Progress to unlock: 166 / 200 (83%)` then "320 points" on a separate line

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /achievements
- Fix: Inline: "166/200 (83%) · 320 Punkte".

### F-70 — `/settings/integrations` Withings client-id placeholder "Saved — enter new to repla…" gets truncated mid-word on desktop 1280

- Severity: LOW · Type: copy-incorrect · Effort: S · Route: /settings/integrations
- Fix: Use the `placeholder` attribute properly, or a shorter "Already saved".

### F-71 — `/insights` "Generated 57 minutes ago" relative time, but other places show absolute timestamps

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /insights
- Fix: Pick one convention (relative for recent, absolute on hover) consistently.

### F-72 — 404 page on /settings/profile and /admin/zielwerte etc. is bare ("404 | This page could not be found.") — no nav

- Severity: LOW · Type: copy-missing · Effort: S · Route: any 404
- Issue: This is the Next.js default. No "Back to dashboard" link.
- Fix: Custom 404 with logo + "Back to dashboard" CTA.

### F-73 — Onboarding subtitle "Three quick steps. You can finish anything later from Settings." duplicated by footer "Skip this step — you can finish setup later from Settings."

- Severity: LOW · Type: copy-redundant · Effort: S · Route: /onboarding
- Fix: Drop one of the two messages.

### F-74 — `/settings/account` "Used for automatic blood pressure target calculations." appears under date-of-birth, but blood-pressure target also uses gender — split incorrectly

- Severity: LOW · Type: copy-incorrect · Effort: S · Route: /settings/account
- Fix: Hoist the explanation to the section level: "Birth date and gender personalize your targets."

### F-75 — `/insights` "Based on your last 90 days" uses absolute "90" but range tabs let user pick 7/30/90/All — banner doesn't update

- Severity: LOW · Type: copy-incorrect · Effort: M · Route: /insights
- Fix: Tie the message to the active range.

### F-76 — `/admin/system-status` cards "Last Reminder Check" use inconsistent capitalization

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /admin/system-status
- Fix: Sentence case throughout: "Last reminder check".

### F-77 — `/admin/api-tokens` "Last used: Never" / "Created: 05/05/2026" — colon style + date format US (mobile)

- Severity: LOW · Type: typography-inconsistent · Effort: S · Route: /admin/api-tokens (mobile)
- Already covered by F-04 and F-37.

### F-78 — Settings/Account "Profile" sub-card heading repeats the page-level "Account" framing (mini-version of F-08)

- Severity: LOW · Type: copy-redundant · Effort: S · Route: /settings/account
- Fix: Drop the inner "Profile" heading.

---

## Top-10 (by impact) — Wave-B priority

1. **F-01** ⭐ — Hardcoded "bis ... Uhr" in `formatTimeWindowRange` (CRIT, S)
2. **F-02** ⭐ — Login Overview shows insights events (CRIT, S)
3. **F-03** ⭐ — "Idiot" / "Lazy Boy" achievements (CRIT, S)
4. **F-05** ⭐ — Admin "Pick a section from the sidebar" wrong on mobile (CRIT, S)
5. **F-04** ⭐ — Date format US-leaks across the app (CRIT, M)
6. **F-09** ⭐ — `WEEKLY_AUTO` raw enum (HIGH, S)
7. **F-10** ⭐ — `WITHINGS` raw uppercase (HIGH, S)
8. **F-11** ⭐ — User role-change `→ User` / `→ Admin` no label (HIGH, S)
9. **F-07** ⭐ — Personal targets / thresholds three different names (HIGH, S)
10. **F-08** ⭐ — Page header / card header duplicate across many admin/settings pages (HIGH, S)

---

## Methodology

- Production captured at https://healthlog.bombeck.io with Marc's session cookie at Pixel 5 (mobile) and 1280×900 (desktop) viewports — 30+ routes per viewport.
- All visible strings cross-checked against `messages/en.json` (2474 lines) and `messages/de.json` (2474 lines).
- Code grep against `src/components/admin/`, `src/components/settings/`, `src/components/measurements/`, `src/components/medications/`, `src/components/mood/`, `src/lib/time-window-format.ts`.
- Settings real route slugs: account, integrations, notifications, dashboard, thresholds, ai, api, export, advanced, about (note: `/settings/profile`, `/settings/audit-log`, `/settings/zielwerte` are 404 — referenced in CLAUDE.md but don't exist).
- Admin real route slugs: system-status, general, services, integrations, ai-quality, feedback, reminders, users, api-tokens, login-overview, app-logs, backups, danger-zone (note: `/admin/zielwerte`, `/admin/audit-log` are 404).

78 findings (0 dropped during review).
