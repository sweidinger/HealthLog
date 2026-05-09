# v1.4.16 backlog (deferred from v1.4.15 phase D)

Severity-grouped, file:line, terse. Items here came out of the parallel
phase-D code-review / security / design / senior-dev / simplify
agents.

---

## HIGH — deferred (correctness / coupling)

### code-review (4)

- **H1** — `src/app/api/admin/backups/[id]/restore/route.ts:253-377` —
  scrub raw Prisma error in catch block; return stable "Restore failed"
  500 + audit row carries verbose text. Admin-only leak, low blast.
- **H2** — `src/app/api/admin/backups/[id]/restore/route.ts:353-366` +
  `src/lib/validations/backup.ts:73-81` — tighten `moodEntrySchema.tags`
  to `z.union([z.null(), z.string().refine(JSON.parse → array)])` OR
  validate via JSON-parse in pre-tx loop.
- **H3** — `src/components/charts/mood-chart.tsx:185-219` vs `:247-292`
  — exported `aggregateMoodEntries` and inline `chartData` aggregation
  diverge; unit test exercises a bucketing user never sees. Either drop
  the export or refactor `chartData` to call it. Charts visual style
  constraint applies — function-extract only, no visual change.
- **H4** — `src/components/onboarding/tour-launcher.tsx:138-170` —
  scope sessionStorage keys (`healthlog-tour-session-dismissed`,
  `healthlog-tour-referrer`) by user id OR clear on logout.
  Multi-account / impersonation only.

### design / UX (1 of 5 — others fixed)

- **H4 design** — Button/Tabs/Switch default heights below 44 px on
  the new B1/B3/B5 surfaces:
  `src/components/admin/backups-section.tsx:84,343,397,438,492`,
  `src/components/settings/notification-status-card.tsx:264,280`,
  `src/components/onboarding/tour.tsx:385,396,405`,
  `src/components/admin/recent-audit-preview.tsx:80-83`.
  Cross-cutting `button.tsx` `h-9 → h-11` bump, sweep call-sites.

### senior-dev (4)

- **H1 senior** — `src/app/page.tsx` (1031 LOC) — split
  `<DashboardShell>` + `<DashboardTileStrip>` + `<DashboardChartGrid>`
  + `<DashboardEmptyState>`; pull visibility resolver into
  `src/lib/dashboard-visibility.ts`. Mechanical.
- **H2 senior** — `src/components/settings/integrations-section.tsx`
  (883 LOC) — split into
  `src/components/settings/integrations/{integration-status-banner,
  withings-card, moodlog-card}.tsx` + composing index. Mirror admin
  per-section pattern.
- **H3 senior** — Process — adopt
  `superpowers:using-git-worktrees` per parallel agent so commit
  messages match diffs. Eight v1.4.15 commits had drift.

---

## MEDIUM — deferred

### code-review

- **M1** — `src/lib/ai/generate-insight.ts:155-158` — retry-once
  injects correction into `userPrompt`, not `systemPrompt`; either fix
  the path or fix the docstring.
- **M2** — `src/lib/ai/codex-client.ts:101-138` — document
  `getLastDiagnostics()` not concurrent-safe OR move into
  `generateCompletion()` result envelope.
- **M3** — `src/lib/notifications/channel-state.ts:90-130` — collapse
  the two Prisma writes into one transaction so increment +
  retry-stamp + audit are atomic.
- **M4** — `src/lib/notifications/dispatcher.ts:75-97` — legacy
  Telegram migration upserts `enabled: true` on every send; will
  re-enable channels B3 auto-disabled. Add guard "only when no row
  exists at all" or stop touching `enabled`.
- **M5** — `src/components/charts/medication-compliance-chart.tsx:75-92`
  — render days where `taken === 0 && scheduled > 0` as missing-data
  (skip / dashed) instead of 0 %. Charts visual constraint applies —
  semantic-only, no Dracula change.
- **M6** — `src/lib/notifications/dispatcher.ts:108-111`,
  `src/lib/integrations/status.ts:476-484`,
  `src/app/api/internal/deploy-webhook/route.ts:128-141` — split
  `SYSTEM_ALERT_DEPLOY` / `SYSTEM_ALERT_INTEGRATION` event types so
  admins can opt out of one without losing security alerts.
- **M7** — `src/components/doctor-report/doctor-report-dialog.tsx:64-75,
  151-152` — anchor date range to Europe/Berlin explicitly OR document
  the off-by-one boundary risk.

### security

- **M1 sec** — `src/app/api/admin/backups/[id]/restore/route.ts:253-377`
  — pass `{ timeout: 30_000, maxWait: 5_000 }` to `prisma.$transaction()`;
  default 5s trip leaves user partially restored on slow disk / large
  payload.
- **M2 sec** — `src/app/api/admin/backups/upload/route.ts:193`,
  `src/lib/crypto.ts:199` — capture `extractKeyId(encrypted)` in
  `admin.backups.upload` audit `details` for forensic key-rotation
  trace.
- **M4 sec** — `src/app/api/admin/audit-log/route.ts:34-53` — document
  `details` JSON returned cross-tenant, must be tightened before any
  multi-tenant release.
- **M5 sec** — `src/app/api/admin/notifications/test/route.ts` —
  add `checkRateLimit('admin-notifications-test:' + admin.id, 5, 5min)`
  mirroring user-side test endpoints.
- **M6 sec** — `src/app/api/admin/backups/[id]/download/route.ts:92-114`
  — RFC 5987 filename or drop userId from filename; defensive against
  future ID-format change.
- **M7 sec** — `src/app/api/admin/backups/[id]/restore/route.ts:259-279`
  — decide + document: restore preserves WithingsConnection,
  IntegrationStatus, encrypted credentials, Telegram creds. Either
  extend delete scope to mirror `DELETE /api/admin/data` OR document
  current preservation behaviour.

### design

- **M1 design** — `src/components/admin/recent-audit-preview.tsx:136-140`
  — show compact verb badge on `<sm` instead of hiding action label.
- **M2 design** — `src/components/admin/backups-section.tsx:124-141`
  — destructive button disabled-state legibility on dark bg.
- **M3 design** — `src/components/admin/backups-section.tsx:371-410`
  — drag-and-drop affordance on backup upload area.
- **M4 design** — `src/components/onboarding/tour.tsx:307-309` +
  `:328-334` — define click-flow under spotlight cutout (block clicks
  OR advance on target click).
- **M6 design** — `src/app/achievements/page.tsx:368-370` — visually
  distinguish category-completed (`5/5`) from in-progress (`2/5`) with
  dracula-green badge or trophy icon.
- **M7 design** — `src/components/gamification/recent-achievements-card.tsx:127-130`
  — empty card needs CTA pointing to first-unlock action. Use
  `<EmptyState size="compact">`.
- **M9 design** — `src/components/settings/integrations-section.tsx:158,165`
  + `notification-status-card.tsx` — switch absolute timestamps to
  relative ("vor 3 Min.") once `useFormatters().relativeTime` helper
  exists. Helper itself is also a v1.4.16 task.

### senior-dev

- **M1 senior** — Reliability state-machine duplication
  (`src/lib/integrations/status.ts` + `src/lib/notifications/channel-state.ts`
  + `src/lib/notifications/retry-policy.ts`); extract
  `src/lib/reliability/` once a third consumer exists.
- **M2 senior** — `src/lib/notifications/dispatcher.ts:49-105` —
  delete legacy `User.telegramBotToken/chatId` migration block + the
  three deprecated User columns in a v1.4.16 schema migration. Verify
  via SQL audit first.
- **M3 senior** — `src/components/admin/backups-section.tsx` (529 LOC)
  — extract `<TypedConfirmDialog>` to
  `src/components/admin/_dialogs/`, `formatBytes` to
  `src/lib/format.ts`, `download-blob` plumbing to
  `src/lib/download-blob.ts`.
- **M4 senior** — `src/components/onboarding/tour.tsx` — extract
  `measureTarget` + `computeTooltipPosition` to
  `src/lib/onboarding/tour-positioning.ts` for unit-test isolation.
- **M5 senior** — `src/app/api/internal/deploy-webhook/route.ts` —
  unify `meta:{}` keys to camelCase (`applicationName`,
  `deployOutcome`); document wire-vs-app boundary.
- **M6 senior** — `src/lib/ai/types.ts` (`insightResultSchema`) +
  `src/lib/ai/schema.ts` (`aiInsightResponseSchema`) — single source of
  truth, migrate route + UI to strict schema, drop `.passthrough()`,
  delete legacy.
- **M8 senior** — Pick one config pattern (lazy env-read vs
  module-frozen) across `integrations/status.ts` + `retry-policy.ts`;
  document in CLAUDE.md.

---

## LOW — deferred

### code-review

- **L1** — `src/components/onboarding/tour.tsx:188` — `TOOLTIP_HEIGHT
  = 220` fixed estimate; measure rendered card via ResizeObserver. (H2
  fix above gave a `max-h-[80vh] overflow-y-auto` band-aid for v1.4.15.)
- **L2** — `src/lib/ai/codex-client.ts:470-475` — comment-clarity nit
  on `redactBody()` regex (downgraded to nit).
- **L3** — `src/lib/analytics/bp-in-target.ts:57-78` —
  `findClosestDia()` O(n²); binary-search after sort.
- **L4** — `src/lib/ai/codex-client.ts:40-45` — drop `gpt-4o` from
  `DEFAULT_SLUG_FALLBACK_CHAIN` OR condition on auth method.
- **L5** — `src/lib/__tests__/dashboard-layout.test.ts` — reclassify
  the typecheck errors (currently called pre-existing in STATE.md but
  the file is +119 in this milestone).

### design

- **M5 design** — `src/app/achievements/page.tsx:261,280,294` —
  `min-h-34` non-standard; switch to `min-h-[8.5rem]` or `min-h-36`.
- **M8 design** — `src/components/settings/notification-status-card.tsx:202-256`
  — colour disabled-reason `text-destructive`, consecutive-failures
  `text-dracula-orange` for at-a-glance triage.
- **M10 design** — `src/components/onboarding/tour.tsx:337-344` —
  live-region `: ` → `, ` so screen readers don't speak punctuation.
- **M11 design** — `src/components/layout/sidebar-nav.tsx:514` —
  tighten admin-sub-item active match to
  `pathname === sectionPath || startsWith(`${sectionPath}/`)`.

### security

- **M3 sec** — `src/lib/ai/codex-slug-cache.ts:32-34` — document the
  global cache; add Wide Event annotation on slug-rejection
  invalidation.
- **M8 sec** — `src/app/api/internal/deploy-webhook/route.ts:84-96` —
  acknowledged trade-off, no change needed.

### senior-dev

- **L1 senior** — Frozen-tuple style inconsistency across charts /
  retry-policy / dashboard-visibility; document canonical pattern.
- **L2 senior** — `src/components/onboarding/tour-launcher.tsx:124-130`
  — trim 8-line StrictMode comment.
- **L3 senior** — `src/lib/integrations/status.ts:365-383` — write
  `null` on encrypt failure instead of sentinel string.
- **L4 senior** — `RANGE_DAYS = [7,30,90]` duplicated across
  `medication-compliance-chart.tsx` + `health-chart.tsx`; extract.
- **L5 senior** — `MOODLOG_LAST_SYNCED_AT` + `IntegrationStatus.lastSuccessAt`
  duplication; document v1.4.16 cutover.
- **L6 senior** — `src/lib/ai/codex-client.ts:477-483` — replace
  `__test` namespace with named exports.
- **L7 senior** — Function-signature consistency (`channel-state.ts`
  positional vs `status.ts` object-arg-bag).
- **L8 senior** — `src/components/gamification/recent-achievements-card.tsx:56-75`
  — move `pickRecentUnlocks` to `src/lib/gamification/recent-unlocks.ts`;
  same for `aggregateMedicationCompliance` in
  `medication-compliance-chart.tsx`.

---

## Simplify — deferred (4 of 6 yes-items not applied autonomously)

- **F1** — `src/lib/ai/{generate-insight,schema,mock-client}.ts` +
  `prompts/insight-generator.ts` — schema-enforcement wrapper wired
  into tests only. Ship-it call: keep as v1.4.16 scaffolding OR revert.
- **F2** — `src/lib/ai/codex-client.ts:101-138, 174-178, 192-198,
  233-237, 242-246` — `getLastDiagnostics()` + `CodexAttemptDiagnostics`
  read only by tests. Either wire into `annotate()` or delete.
- **F8** — `src/lib/doctor-report-{data,pdf,pdf-core}.ts` —
  `period.since` back-compat shim duplicates `period.start`. Drop
  after confirming iOS app does not read `since`.
- **F9** — `src/components/onboarding/tour-launcher.tsx:138-170` —
  delete `decidedFor` over-engineered guard; `showTour === null`
  already prevents re-fire.
- **F12** — `src/lib/ai/mock-client.ts:99-102` — drop `callCount`
  getter; conditional on F1.

---

## Process / meta

- Adopt `superpowers:using-git-worktrees` per parallel agent for the
  v1.4.16 marathon.
- Migrate route + UI for AI insights to the strict schema; retire
  `.passthrough()`.
- Resolve the dashboard-layout.test.ts typecheck regression (currently
  blocking `pnpm typecheck`).
