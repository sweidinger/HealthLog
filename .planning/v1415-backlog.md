# v1.4.15 backlog

Seeded from phase-6 multi-agent QA findings (code-review, security,
design, simplify). Severity-grouped, file:line, one-line recommendation.

Phase 6 reconcile commits:

- `refactor(v1.5): apply simplify-review safe-to-apply suggestions` (88c8db1)
- `fix(security): block force-logout from targeting the admin's own session` (b3f282a)
- `fix(admin): rate-limit /api/admin/backups/run to 3/min per admin` (8e17f22)
- `fix(security): redact standalone hlk_ / hlr_ native API tokens in logs` (f0cfd26)
- `fix(a11y): drop duplicate h2 inside single-section /admin/<slug> routes` (bd24f13)
- `fix(a11y): bump /admin/users + /admin/login-overview tap targets to WCAG 2.5.5` (499cfad)
- `fix(admin): default api-tokens + login-overview routes to expanded` (ef96e87)

---

## HIGH (deferred)

- **H4+H5 design (StatusCardGrid i18n)** — `src/components/admin/status-card-grid.tsx:25-31, 53, 113-130, 139-223` — move SEVERITY_LABEL, card titles/CTAs, fmtRelative, fmtUptime, and StatusBadge aria-label to i18n keys with EN+DE parity (`admin.statusGrid.severity.*`, `admin.statusGrid.cards.*.{title,cta}`, `admin.statusGrid.statusAriaLabel`). Update `status-card-grid.test.tsx` accordingly.
- **H2 code-review (admin role check is client-only)** — `src/app/admin/[section]/page.tsx:35-50`, `src/app/admin/page.tsx:30`, `src/app/admin/[section]/renderer.tsx:46` — add `requireAdmin()` to the server-component page so non-admin users 403 before the shell paints (eliminates the "shell flashes briefly" hydration window). Document precedent matches API-route `requireAdmin()`.
- **H-1 security ("Wipe all data" leaves encrypted secrets and personal rows)** — `src/app/api/admin/data/route.ts:51-95` and `src/lib/jobs/reminder-worker.ts:1019-1032` — decision needed: (a) widen scope to clear `MoodEntry`, `RefreshToken`, `DataBackup`, `Device`, `UserAchievement`, `IdempotencyKey`, plus the encrypted Codex/AI/moodLog columns and `aiProvider/aiModel/aiBaseUrl/locale/displayName/...`, OR (b) rename the operation + i18n copy from "Wipe all data" to "Reset health data" with an explicit "preserved" list. Recommend (a) for GDPR Art 17 alignment.

## MEDIUM

### Code review

- **M1** `/insights` TrendCard tile-strip not wired with `directionSentiment` — `src/app/insights/page.tsx:830-922` — propagate up-bad / up-good / neutral from dashboard.
- **M2** Legacy admin-anchor 301s leak slug existence to unauth'd hits — `src/proxy.ts:97-107` — move legacy-redirect block AFTER the session check.
- **M3** `BackupsSection` 2-second `setTimeout` for refetch is a guess — `src/components/admin/backups-section.tsx:59-61` — bump to 5–8s with double-invalidate, or poll job state.
- **M4** `dynamic = "force-dynamic"` missing on `/api/admin/users/[id]/force-logout` — `route.ts:18` — add for consistency.
- **M5** `formatBytes` types its second arg as `ReturnType<typeof useFormatters>` — `src/components/admin/backups-section.tsx:24-30` — define a local `Formatters` type.
- **M6** `weight-status.ts` synthesises a misleading `n: 1` for `bpMeanDaily` — `:251-264` — widen `DailyBucket.n` to optional or carry through `min(sysN, diaN)`.
- **M7** Dashboard console-error filter regex doesn't match 404s for SW manifest icons — `e2e/dashboard.spec.ts:175-181` — convert to allowlist with KNOWN_OK list.

### Security

- **M-2** `/api/admin/users/[id]/force-logout` has no rate limit and no last-admin guard — `route.ts:18-56` — add `checkRateLimit(`admin-force-logout:${admin.id}`, 30, 60_000)` and refuse to revoke the only active admin session.
- **M-3** Wide-Event `meta` entries are not redacted before egress — `src/lib/logging/event-builder.ts:104-108`, `context.ts:24-28`, `transports.ts:6-12` — run `redactSecrets()` over string values in `addMeta()`.
- **M-4** `redactSecrets` over-redacts MIME-type-like / path strings starting with `sk-` — `src/lib/logging/redact.ts:38` — add a regression test asserting current (over-redact) behaviour.
- **M-5** Wipe rate-limit checked BEFORE auth — unauth'd traffic mutates `rate_limits` — `src/app/api/admin/data/route.ts:16-24` — reorder so `requireAdmin()` runs first, key by `user.id`.

### Design / UX

- **M1 design** `IntegrationsGroupSection` h2 hierarchy needs JSDoc note on `<SectionFrame>` — `src/components/admin/integrations-group-section.tsx`.
- **M2 design** `BackupsSection` 2-second timeout (duplicate of code-review M3).
- **M3 design** `<BackupsSection>` lacks row-shaped skeleton — `:108-114` — replace `<Loader2>` block with 4 skeleton rows.
- **M4 design** `/admin/users` lacks row-shaped skeleton + filter empty-state — `user-management-section.tsx:316-322` — 5 skeleton rows + `noResultsForFilter` i18n key.
- **M5 design** `/insights` deferred Recharts skeleton vs rendered chart pixel-parity — `src/app/insights/page.tsx:59-62` — add Playwright pixel-size assertion in CI.
- **M6 design** `<FeedbackInboxSection>` `<TabsList>` lacks `overflow-x-auto` — `:92-105` — wrap in mobile-strip pattern.
- **M7 design** `text-green-400` / `text-red-400` / `text-yellow-400` raw Tailwind in reminders-section — `:242, 244, 285, 287, 289, 303` — swap to `--success` / `--warning` / `--destructive` (light-mode contrast fail).
- **M8 design** Broader `text-dracula-green` → `text-success` semantic-token sweep — covers danger-zone `:123`, api-token-overview `:120`, system-status `:48,86,107,123,133,141`, login-overview `:140`, glitchtip `:86`, umami `:89`, web-push-vapid `:64`, bug-report `:61`, user-management `:435`, plus the settings-side cards (telegram, ntfy, web-push, account, about, advanced, integrations, api, test-connection-button), and ai-section `:342, 413, 424` (still has dracula-purple).
- **M9 design** `/insights` sticky `<nav>` lacks `aria-label` — `:1605` — add `t("insights.sectionNav")` + EN+DE keys.
- **M10 design** `/admin/integrations` mobile cards visually merge — `integrations-group-section.tsx:18-25` — bump to `space-y-8` or add group h3 labels.
- **M11 design** Sidebar "Admin Console" expanded sub-list lacks user-controlled toggle — `sidebar-nav.tsx:472-500` — add aria-expanded button + Esc handler.
- **M12 design** Trend-arrow direction-as-good color is sole signal (color-blind users) — `src/components/charts/trend-card.tsx:96-108` — add `aria-label` (text equivalent) to TrendIcon. **Charts file — confirm with Marc before touching.**

## LOW

### Code review

- **L1** `weight-status.ts` / `mood-status.ts` "newest bucket" comment correctness — already verified, no action.
- **L2** `CodexClient.buildUpstreamError` re-implements redaction inline — `src/lib/ai/codex-client.ts:99-116` — replace with `redactSecrets()` from `@/lib/logging/redact`.
- **L3** `dynamicParams = false` is sync — already fine.
- **L4** `LEGACY_ADMIN_ANCHORS` in proxy.ts duplicates section-slugs map — `src/proxy.ts:64-78` (`LEGACY_ANCHOR_TO_SLUG` was removed in simplify commit; proxy.ts still has its own copy). Keep until proxy.ts shape is reviewed.
- **L5** `e2e/measurement-flow.spec.ts:148-157` polls for "78,4"/"78.4" without row-scoped locator.
- **L6** `redact.ts` lacks JSON-encoded-key positive test — `__tests__/redact.test.ts` — add `{"apiKey": "sk-..."}` case.
- **L7** `mood-status.ts:288-291` `tagWindowCutoff` uses `MS_PER_DAY` arithmetic, not Berlin-day math — fuzzy by design, document.

### Security

- **L-1** `/api/auth/codex/callback` listed as PUBLIC_PATH but no route file exists — `src/proxy.ts:26` — delete the entry.
- **L-2** Codex `codex_device` cookie lacks per-user binding — `src/app/api/auth/codex/device-poll/route.ts:38-51` — embed `userId` inside the encrypted blob and reject mismatch.
- **L-3** `LEGACY_REDIRECTS` ordering UX — minor; no action needed.

### Design / UX

- **L1 design** `/settings/ai` device-code panel `border-l-4 border-dracula-purple` washed out in light mode — `ai-section.tsx:413` — use `--info` token.
- **L2 design** `<TrendCard>` mobile padding tight — `trend-card.tsx:124` — `p-3 md:p-6`. **Charts file — confirm with Marc.**
- **L3 design** `<BottomNav>` 7 items × 49px wide is at WCAG 2.5.5 floor — `bottom-nav.tsx:17-25,38` — defer to v2.0.
- **L4 design** Status-card 3-metric `<dl>` wraps awkwardly with longer DE labels — `status-card-grid.tsx:93-100` — `min-w-0` on each cell.
- **L5 design** `/admin/users` table horizontal scroll on mobile — `user-management-section.tsx:199,224` — defer to v2.0 (card-list mobile layout).
- **L6 design** `<AdminShell>` mobile horizontal section strip lacks scroll-snap — `admin-shell.tsx:152-176` — add `snap-x snap-mandatory` + `snap-start`.
- **L7 design** `<AlertDialog>` Radix-default focus on Cancel — already correct, no action.
- **L8 design** Top-bar review deferred — already on phase-5 v1.4.15 backlog.

## Simplify (deferred / no-change)

- **Finding 5** Defensive `notFound()` after `dynamicParams = false` — let Marc choose between (a) trim comment vs (b) drop guard + cast.
- **Finding 12** Historical-anchor comments (`v1.4.6 T2.6`, `P15`, `v1.4.7.1`) — judgement-call sweep, defer.
- **Finding 13** Massive duplication across the 3 status generators (mood / weight / blood-pressure ~270 LOC paste) — extract `_status-helpers.ts` with `toBerlinDayKey`, `round`, `summarizeSeries`, `pairDailyBuckets`, `normalizeLocale`, `normalizeSummaryText`. Medium-risk; needs focused refactor + test rerun.
- **Finding 14** `formatBytes` accepts `fmt: ReturnType<typeof useFormatters>` it barely uses — borderline cosmetic.
- **Finding 18** `getApiErrorMessage` falls through to same fallback — too cosmetic.
- **Finding 19** `// eslint-disable-next-line react-hooks/exhaustive-deps` on device-code polling effect — verify deps don't cause re-poll loop, then either list or document.

## Verified positive (no action needed)

- L-4 security: `requireAdmin()` is cookie-only — Bearer iOS tokens cannot reach admin routes.
- Codex flow token storage + PKCE + log redaction verified.
- Notification-channel wipe scope expansion verified.
