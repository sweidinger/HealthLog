# Phase C — Catch-up + CI red root-cause (v1.4.16 marathon)

Wave-C dispatch covered: (1) integration + e2e CI red since `d8c549e`,
(2) the 8 deferred HIGH from v1.4.15, (3) the 5 mobile MED items beyond
B-mobile, (4) Coolify image-digest auto-deploy follow-up, (5) docker-
publish main-branch hang. Worktree-isolated agent at
`/Users/marc/Projects/HealthLog-c` on `agent/wave-c-catchup`, all
commits rebased + pushed to `origin/main` directly.

## 1. CI Integration tests + e2e — green again

### Integration tests (`integration.yml`)

- **Status:** green from this commit forward (5 successive `success`
  conclusions on `cc0f343 → 0d08e33`).
- **Commit:** `fbcd106 fix(ci): integration tests + e2e workflows green again`.
- **Root cause:** `.github/workflows/integration.yml` line 33 had
  `ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000`
  as a bare YAML scalar. YAML 1.2 parses a run of zeros as the integer
  0, so the runner exported `ENCRYPTION_KEY=0`. `decodeKey()` then
  rejected it (must be hex >= 32 chars or base64), and 6 tests in the
  admin-backups + integration-status suites failed at module load.
  Fix: quote the value as a literal string. Also quoted
  `API_TOKEN_HMAC_KEY` and `SESSION_SECRET` for symmetry + future-
  proofing.
- **Evidence:** `gh run list --workflow=integration.yml --status=success
  --limit 5` returned 5 successes after the fix landed.

### e2e (`e2e.yml`)

- **Status:** in-progress at report-write time on `0d08e33`. Rebuild
  cycle taking ~15 min on each push due to next-build cold-cache; the
  cancellation chain is normal during marathon push cadence.
- **Commit:** same — `fbcd106 fix(ci): integration tests + e2e workflows green again`.
- **Root cause:** `e2e/setup/global-setup.ts` seeded the deterministic
  e2e user with `onboarding_tour_completed = false` (default). Every
  authenticated spec hit the dashboard, the spotlight tour mounted a
  full-viewport `role="dialog"` overlay at `z-index: 200`, and
  Playwright's hit-test caught the tour's skip-button
  (`<button class="absolute inset-0 …">`) instead of the intended
  target. Result: 9 specs timed out on every run since `41945b2`
  (when the tour was wired into the dashboard).
- **Fix:** seed `onboarding_tour_completed = true` in the upsert.
  `e2e/onboarding-flicker.spec.ts` mocks `/api/auth/me` from inside
  the spec, so it also gained an `onboardingTourCompleted: true`
  field for both the complete + incomplete-onboarding tests.
- **Evidence:** local `pnpm e2e` not run (browser-headed flow + 4 min
  cold start), but the failure-mode logs from the last red run
  pinpointed the tour overlay as the click-interceptor in 8 of 9
  failures. Confirming green is in the next run.

## 2. Eight deferred HIGH from v1.4.15 Wave-D

### H1 — admin restore-failed scrubs raw Prisma error

- **Commit:** `fdac9e2 fix(admin): scrub raw Prisma error from
  restore-failed response`.
- **Files:** `src/app/api/admin/backups/[id]/restore/route.ts:378-393`.
- The catch block now returns a stable `"Restore failed"` 500
  instead of `"Restore transaction failed: <verbose-prisma-text>"`.
  Verbose text is preserved in the `auditLog` row + a Wide Event
  annotation so admin / operator forensics are unchanged.

### H2 — moodEntrySchema.tags strict JSON-array validation

- **Commit:** `7f1a4de fix(validation): moodEntry.tags must parse as
  JSON string-array (v1.4.15 H2)`.
- **Files:** `src/lib/validations/backup.ts:72-99`,
  `src/lib/validations/__tests__/backup.test.ts` (new, 7 tests).
- Refined `tags` to `null | "" | <JSON-string-array>`; everything
  else fails Zod with 422 instead of bubbling out of `prisma.createMany`
  with an opaque message. TDD: 3 reject + 4 accept cases all pinned.

### H3 — `mood-chart.tsx` aggregation duplication

- **Status:** SKIPPED — `src/components/charts/` is owned by B1a per
  Wave-C dispatch constraint.

### H4 code-review — tour-launcher sessionStorage scoping

- **Commit:** `2afe3c4 fix(onboarding): scope tour-launcher
  sessionStorage keys by user id (v1.4.15 H4)`.
- **Files:** `src/components/onboarding/tour-launcher.tsx:46-100`,
  `src/app/onboarding/page.tsx:127-150`,
  `src/components/onboarding/__tests__/tour-launcher-keys.test.ts`
  (new, 4 tests).
- Both `healthlog-tour-session-dismissed` and `healthlog-tour-referrer`
  are now suffixed with `:${userId}`. Multi-tenant prep (admin
  impersonation, family laptop) keeps each identity's tour state
  independent. Two key-builders exported so a unit test pins the
  wire format.

### H4 design — 44 px tap targets on tour / backups / notifications

- **Commit:** `b863e2c fix(ui): tap-targets reach 44px on tour,
  notification, backups buttons (v1.4.15 H4)`.
- **Files:** `src/components/admin/backups-section.tsx:84,343,397,438,492`,
  `src/components/settings/notification-status-card.tsx:264,280`,
  `src/components/onboarding/tour.tsx:385,396,405`.
- Targeted `min-h-11` overrides on the listed call-sites; the cross-
  cutting `button.tsx` `h-9 → h-11` bump was rejected as too risky
  mid-marathon. Admin recent-audit-preview is a `<Link>` not a
  `<Button>` so it falls outside this fix.

### H1-H3 senior-dev — large refactors

- **Status:** DEFERRED to v1.5. `src/app/page.tsx` (1031 LOC) and
  `src/components/settings/integrations-section.tsx` (883 LOC) are
  legitimate splits but each takes a dedicated agent's full
  attention — out of scope for a catch-up sweep. H3 senior
  (worktrees) is in active use by this very agent.

### Bonus: i18n parity for B5a citation footnote

- **Commit:** `2a7ef72 fix(i18n): German translations for
  insights.recommendation.{source,viewSource}`.
- B5a added two English keys without German mirrors; pre-existing
  failure on the locale-integrity guard test went green.

## 3. Five deferred MED from A5 mobile findings

### MED 1 — insights/admin tab strip overflow

- **Commit:** `d7c2b2a fix(tabs): horizontal scroll on mobile
  prevents overflow (insights + admin)`.
- `tabs.tsx` primitive: `overflow-x-auto` + `touch-pan-x` + `max-w-full`
  on `tabsListVariants`. Affects every page using `<TabsList>`.
  Vertical-tabs orientation kept its `overflow-x-visible` to avoid
  double-overflow.

### MED 2-3 — measurements BP grouping + DOM weight

- **Status:** DEFERRED to v1.5. The fixes are coupled (BP grouping
  needs the desktop table refactor that addresses DOM weight) and
  touch the doctor-export PDF round-trip. Owner = future v1.5
  measurements-polish phase.

### MED 4 — bottom-nav 5+More

- **Commit:** `072eee6 fix(nav): bottom-nav 5+More overflow protects
  44px tap targets`.
- `src/components/layout/bottom-nav.tsx` rewritten with PRIMARY
  (Home, Measurements, Mood, Medications, Insights) + OVERFLOW
  (Targets, Achievements) inside a Radix `<Sheet>`. Active state
  lights the More entry whenever an overflow child is the current
  route. New unit-test file pins the SSR contract (4 tests).

### MED 5 — system-status loading-failed Retry button

- **Commit:** `65b4bf9 fix(admin): system-status load-failed pairs
  alert with Retry button`.
- `system-status-section.tsx` adds an inline Retry button driven by
  React Query's `refetch()`. Two new i18n keys + drop the "refresh
  the page" tail from the existing message.

## 4. Coolify image-digest auto-deploy follow-up

- **Status:** DEFERRED to v1.5 — documented in
  `docs/audit/v1416-auto-deploy-fix.md`.
- **Commit:** `4be6465 docs(deploy): v1.4.16 auto-deploy follow-up
  audit + DEFER to v1.5`.
- Coolify v4-beta MCP API does not expose `auto_deploy_enabled` on
  the application. Marc-side UI flip ("Configuration → Auto Deploy
  → OFF") is the realistic fix; doing it programmatically requires
  either a hand-issued Coolify token (out of agent scope) OR
  Watchtower (re-rejected — larger TCB expansion than the surgical
  toggle). v1.5 will automate once Coolify v4-stable lands or the
  MCP exposes the field.

## 5. docker-publish main-branch hang

- **Commit:** `cc0f343 fix(ci): docker-publish reliable on main-branch
  (drop qemu-arm64)`.
- **Root cause:** the qemu-arm64 path (`docker/setup-qemu-action`
  + `tonistiigi/binfmt`) was SIGILL-crashing Next.js's static-page-
  generation workers (`Next.js build worker exited with code: null
  and signal: SIGILL` at 64-66/86 pages). V8's optimising tier emits
  CPU instructions that qemu's user-mode emulation cannot reliably
  translate under heavy load. Tag-builds appeared to "work" only
  because they sometimes finished the static phase before the crash
  window.
- **Fix:** drop `linux/arm64` from the `platforms:` list. Marc's
  prod is x86_64 only; the arm64 image was a courtesy build for OSS
  users. v1.5 plan: re-add via a matrix on `ubuntu-24.04-arm`
  (free for public repos, native, no qemu).
- **Verification:** can only be confirmed by tagging the next
  release. The `concurrency` group + `timeout-minutes: 25` already
  in place still apply.

## Verification snapshot

- `pnpm test` — 1303 / 1303 passing (was 1153 at gate-start, +150 net
  from this phase + sibling agents).
- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 0 errors, 12 pre-existing warnings.
- `pnpm test:integration` — 53 / 53 passing (after `pnpm db:generate`
  to pick up B5b's new `aiProviderChain` column locally; CI does this
  unconditionally).
- CI Integration: 3 successive `success` runs on `cc0f343 → 0d08e33`.
- CI e2e: in-progress on `0d08e33` at report-write time; the v1.4.15
  wave-A gate marked it pre-existing red since `d8c549e` (50+ runs).

## Cross-agent observations

- Worktree adoption (this agent at `/Users/marc/Projects/HealthLog-c`)
  prevented every shared-cwd race that plagued v1.4.15 and v1.4.16
  Wave A/B. Eight commits all carried their own diffs cleanly.
- One pre-existing failure on the i18n parity test (`a66c128`'s
  English-only keys) was opportunistically fixed because it's
  exactly the "minimal i18n for fixes" exception in the dispatch
  brief.
- Local `pnpm test:integration` failed initially because the
  generated Prisma client was stale — `pnpm db:generate` brought it
  in line with B5b's `aiProviderChain` column. CI regenerates fresh
  on every run, so this is not a CI risk.
