# v1.4.19 backlog seed

Source: phase-D reconcile (v1.4.18). Items below are deferred from
the QA reviewers (code-review / security / design / senior-dev /
simplify). Strategic v1.5 items live in `.planning/v15-backlog.md`
and `.planning/phase-D-v1418-product-lead-review.md`.

Compiled: 2026-05-10.

---

## HIGH (deferred — fix in v1.4.19)

### From security

- **HIGH-2 — i18n bundle ships hidden-achievement strings to every
  client.** The redaction landed at the API layer (v1.4.18 reconcile
  commit `545f44c`) but `messages/en.json` and `messages/de.json`
  are statically `import`-ed into the client bundle, so a determined
  user can `Cmd-F` `"hiddenNightOwl"` in `_next/static/chunks/*.js`.
  Two viable approaches: (1) build-time strip + on-demand fetch when
  an unlock fires, (2) reversible obfuscation (rot13/base64) decoded
  client-side only when `unlocked === true`. Approach 1 is the v1.5
  fix, approach 2 is the v1.4.19 stopgap. File: `src/lib/i18n/context.tsx:15-16`,
  `messages/en.json` "achievements.badges.hidden\*".

## MED (deferred)

### From code-review

- **M1** — `countMeasurementsByType` only counts `BLOOD_PRESSURE_SYS`
  toward `bpCount`; DIA-only writes (none today) wouldn't earn BP
  badges. `bpCount = max(sys, dia)` if Withings ever ships DIA-only.
  File: `src/lib/gamification/expansion-metrics.ts:74-83`.
- **M3** — `e2e/admin-api-tokens-mobile.spec.ts` only covers the
  AdminShell strip; mirror the spec for `/settings/profile` so the
  SettingsShell pillstrip is also Playwright-guarded against future
  scrollbar regressions. File: `e2e/admin-api-tokens-mobile.spec.ts`.
- **M4** — `chart-overlay-prefs` route doesn't capture previous flag
  state in its `annotate()` call. Capture from/to so audit trail can
  reconstruct toggle history. File:
  `src/app/api/dashboard/chart-overlay-prefs/route.ts`.
- **M5** — `health-chart-overlay-defaults.test.tsx` reads source
  text via `readFileSync` + regex; replace with a SSR render
  assertion for `data-slot="chart-personal-baseline-line"`.
  Files: `src/components/charts/__tests__/health-chart-overlay-defaults.test.tsx`.

### From security

- **MED-1** — Same race condition documented in code-review H1; fix
  shipped in v1.4.18 (commit `cf75579`). Backlog entry retained for
  the broader pattern: every JSON-blob PUT route should follow the
  same Serializable-transaction shape. Audit:
  `src/app/api/dashboard/widgets/route.ts:96-115` (B8 baseline still
  has the un-transactioned R-M-W).

### From design

- **M2 design** — `recent-achievements-card.tsx` iconMap missing 8
  icons used by v1.4.18 expansion (`Smile`, `Scale`, `CalendarDays`,
  `Moon`, `Sun`, `Sparkles`, `FileText`, `Languages`). Falls back to
  `Star`. Either mirror the achievements page iconMap or extract a
  shared `gamificationIconMap` module. File:
  `src/components/gamification/recent-achievements-card.tsx:32-47`.
- **M3 design** — `chart-overlay-prefs` route still missing
  `withIdempotency()` wrapper. CLAUDE.md says all POST/PUT/PATCH/DELETE
  routes wrap. Single-tenant low-priority; flag for v1.5 multi-tenant.
- **M4 design** — Cog visual contrast vs. range tabs is muted. After
  the 44x44 size fix (commit `194ec2f`), bump
  `text-muted-foreground` → `text-foreground/80` so the cog reads
  as a peer. Polish, not function.
- **M5 design** — Mobile section strip swipe affordance now
  invisible (no scrollbar, no fade gradient). Add a right-edge fade
  gradient via `.no-scrollbar-with-fade` so users see "more content
  this way". Files: `src/app/globals.css:217-223`,
  `src/components/admin/admin-shell.tsx:160`,
  `src/components/settings/settings-shell.tsx:143`.
- **M6 design** — `/achievements` hidden-category heading prints
  `0 / 6` for fresh users, telling them exactly how many hidden
  Easter-eggs exist. Suppress denominator: `{unlocked} / ?` for the
  hidden category only. File:
  `src/app/achievements/page.tsx:421-424`.

### From senior-dev

- **F1 senior-dev** — `ChartOverlayPrefs` type duplication. Resolved
  in v1.4.18 reconcile (commit `720e6c8`).
- **F2 senior-dev** — `getAchievementCategory` deprecated wrapper.
  Resolved in v1.4.18 reconcile (commit `720e6c8`).
- **F3 senior-dev** — `src/lib/gamification/achievements.ts` (839
  LOC) is at the watchpoint for a `definitions/ + evaluators/ +
utilities/` split. Defer until a 5th responsibility (cross-user
  leaderboard, server-side rules engine) lands.
- **F4 senior-dev** — `toBerlinDayKey()` reimplemented in
  `src/lib/analytics/bp-in-target.ts` AND
  `src/lib/gamification/achievements.ts`. Promote to
  `src/lib/dates/berlin-day-key.ts` once a third caller arrives.
- **F5 senior-dev** — `src/app/api/gamification/achievements/route.ts`
  (876 LOC) — extract metric helpers to
  `src/lib/gamification/route-helpers.ts` so route stays "fetch +
  serialise" only. Worth doing before v1.5 multi-tenant prep.

## LOW (deferred)

### From code-review

- **L1** — `parseDayKey` in `expansion-metrics.ts:230-232` redundantly
  sets `cursor.setUTCHours(12,0,0,0)` after constructing a noon-UTC
  date. Drop the no-op line.
- **L2** — i18n parity for the v1.4.18 expansion strings — guard test
  exists; no action needed.

### From design

- **L1 design** — `MedicationComplianceChart` hard-codes
  `useChartOverlayPrefs("medications")` with no prop. Mirror the
  HealthChart contract (`chartKey?: ChartOverlayKey`).
- **L3 design** — `chart-overlay-controls` icon contrast at
  `text-muted-foreground` reads ≈3.5:1 default; `text-foreground/70`
  bumps to 5:1 default. Pair with M4 design polish.
- **L4 design** — `chart-overlay-controls` dropdown content width
  240 px; consider `min-w-[200px] max-w-[260px]` so DE-string-length
  doesn't crowd the right edge on 360 px viewports. Add explicit
  `collisionPadding={8}` to the radix Popover.
- **L5 design** — `/insights` charts intentionally don't get the cog
  but no caption explains why; consider a small
  "overlays-set-per-dashboard-card" cue.

### From senior-dev

- **F6 senior-dev** — Hidden-discovery defensive switch case in
  `isEarnable`. Resolved in v1.4.18 reconcile (commit `720e6c8`)
  by merging into the no-precondition block.
- **F7 senior-dev** — AdminShell + SettingsShell mobile-strip markup
  duplication. Defer until a third section shell appears.
- **F8 senior-dev** — `findClosestDia` is O(n·m); fine at current
  scale. Add a binary-search variant if a multi-year backfill ever
  lands.

## Notes / process

- Format drift accumulated across v1.4.x; cleared in v1.4.18
  reconcile (commit `3048dd6` — 72 files swept). Future PRs should
  carry a prettier pass.
- The `.no-scrollbar` utility risk noted by Product-Lead (E.2) is
  not yet acted on. Either rename to `.no-scrollbar-horizontal` +
  assert it's only on `overflow-x` parents, or audit usage on every
  PR. Pair with M5 design fade-gradient.
- Strict-schema legacy-payload pattern audit (Product-Lead E.3) is
  worth a v1.4.19 sweep: `git grep "safeParse" src/lib/` and confirm
  every parse has a graceful fallback path, not a silent crash.
- Hidden-achievement DOM/wire/bundle defense in depth (Product-Lead
  E.6) — add a Playwright assertion that greps the rendered page
  source for any `ACHIEVEMENT_DEFINITIONS` string when the user
  hasn't unlocked it. The redaction landed at the API; a regression
  guard at the page level closes the trap door.
