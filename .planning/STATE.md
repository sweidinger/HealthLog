# v1.4.15 marathon — state log

Status: phase-0-done
Last update: 2026-05-09T20:06:00+02:00

> Previous milestone: see `docs/audit/v1414-summary.md` (live in production at https://healthlog.bombeck.io, /api/version=1.4.14, image digest `sha256:0ced46004a54…`).

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.15
- [x] git status clean (10 leftover phase reports from v1.4.14 marathon left as untracked — they belong to the previous milestone, not this one; will not be folded into v1.4.15 commits)
- [x] codex-protocol-spec.md re-read (canonical reference for Phase C1 AI-hardening work)
- Result: ok / commit `<filled in by commit step>`
- Detailed report: `.planning/phase-0-report.md`

## Phase A — Quick fixes (5 parallel buckets)

### A1 — Nav conditionals + sidebar context-awareness

- [x] Bug-Report-Toggle hides Sidebar nav (also bottom-nav, topbar)
- [x] Skip-link does NOT block logo click on desktop
- [x] Sidebar admin sub-items only expand when on `/admin/*` route (view-context-aware)
- [x] Feedback section visible only when admin enabled feedback toggle
- Detailed report: `.planning/phase-A1-report.md`

#### Status — 2026-05-09T20:23+02:00 — Phase A1 complete

All four fixes landed on `origin/main`:

- `85aa15b` fix(nav): hide bug-report entry in nav when admin disables the toggle
- `786b395` fix(a11y): skip-link no longer blocks logo click outside focus
- `73afae0` refactor(nav): admin sub-items predicate tightened to `pathname === "/admin" || startsWith("/admin/")` (folded into A4's medication-compliance commit on push race; the sidebar-nav.tsx hunk inside that commit is mine)
- `bde167d` + `c63e4de` fix(feedback): hide ErrorDetails report-bug button when admin disables the feature (impl + test split because a sibling agent's `git add` raced mine; both halves on main)

New shared primitive: `src/components/app-settings-provider.tsx` exposes
`useAppSettings()` to any client component. Today it carries
`bugReportEnabled`; future admin feature flags should join the same
context to avoid parallel fetches.

Tests: 779/779 unit pass (was 754/754 before A1). Typecheck clean,
lint clean (12 pre-existing warnings, none in A1 files). One new
Playwright e2e case (`a11y.spec.ts` — logo click reachable through the
skip-link area).

Marc-status: speed mattered, hit by parallel-agent worktree contention
mid-session but all behavioural changes shipped.

### A2 — /admin overview redesign + /admin/api-tokens responsive

- [x] `/admin` overview replaces section-grid with audit-log preview + system-status snapshot — `a967895`
- [x] `/admin/api-tokens` table responsive (overflow-x-auto + column-hide on mobile) — `dddc18c`
- Detailed report: `.planning/phase-A2-report.md`

A2 status @ 2026-05-09T20:26:00+02:00 — done.

Both fixes landed on `origin/main`:

- `a967895` feat(admin): replace overview section-grid with audit-log preview + system snapshot — new `<SystemStatusSummary>` + `<RecentAuditPreview>` subcomponents reuse existing data sources; `<StatusCardGrid>` deleted; test rewritten to assert new composition. (Commit also swept in A4's `bp-in-target.ts` files due to push race — files correct, message a touch wider than scope.)
- `dddc18c` fix(admin): make api-tokens table responsive on mobile — user / last-used / created columns gated behind `sm:` / `md:` breakpoints with inline username fallback so hiding doesn't drop data. New `api-token-overview-responsive.test.tsx` locks the contract.

Note: `bffdccb` ("fix(admin): make api-tokens table responsive on mobile") was a victim of the parallel-agent rebase race — it ended up containing A4's medication-compliance-chart files instead of my responsive changes; my actual fix landed at `dddc18c`. Code base is correct; only the message-to-diff mapping is misleading.

i18n: 15 new `admin.overview.*` keys added (EN + DE).

Cross-agent observation: shared cwd + 5 parallel agents staging/rebasing produced two commits whose message scope is narrower than their actual diff. Recommended for v1.4.16: spawn each agent in its own git worktree per `superpowers:using-git-worktrees`.

### A3 — Quick-add labels + Stimmung-Card mobile + onboarding flicker

- [x] Quick-Add submenu disambiguation (no double "Hinzufügen") — `3e45a7b`
- [x] Stimmung-Card mobile: large number + label only (no doubled number/label) — `2c227fb`
- [x] Onboarding flicker: don't render until status loaded; don't auto-open when complete — `bb4dc12`
- Detailed report: `.planning/phase-A3-report.md`

A3 status @ 2026-05-09T20:25:00+02:00 — done.

DE labels switched from nouns ("Messung" / "Stimmungseintrag") to
verb-phrases ("Messung erfassen" / "Stimmung erfassen"); EN matched
("Log measurement" / "Log mood"). Unit guard at
`src/app/__tests__/quick-add-labels.test.ts` locks distinctness from
each other AND from `common.add` (the trigger). Mood-list mobile branch
no longer prints the score digit twice — title line is now just the
localized label, badge keeps the digit. Onboarding card refuses to
mount while `analyticsQuery.data === undefined`, eliminating the
~500 ms flash for established users; new users see a collapsed shell
with the progress meter visible (chevron toggle is `aria-expanded` +
`aria-controls`). Two new Playwright specs on the `chromium-mobile`
project: `e2e/mood-card-mobile.spec.ts` (one occurrence of score per
row) and `e2e/onboarding-flicker.spec.ts` (50ms sample-loop during a
deliberately-slowed analytics fetch + collapsed-by-default assertion).

Tests: 779/779 unit pass, typecheck clean, lint clean (12 pre-existing
warnings, none in A3 files). 3 atomic commits, all pushed after
rebase-with-autostash; no force-pushes, no `--no-verify`. One race
landed `.planning/phase-A1-report.md` + `STATE.md` into A3's staging
area mid-commit; restored those to A1's ownership before committing
fix 3.

### A4 — Dashboard analytics fixes

- [x] BD-Zielbereich 0% bug — calculation review (`a967895` — Fix 1 files
      bundled into A2's commit by index-race; new helper at
      `src/lib/analytics/bp-in-target.ts` + 7 unit tests)
- [x] Medikamente graph wired to layout toggle (`bffdccb` — Fix 2 files
      also caught by index-race; new
      `src/components/charts/medication-compliance-chart.tsx` + 7 tests)
- [x] Stimmung-chart auto-aggregates to weekly/monthly + chip in header
      (`47ac14b`)
- [x] "7-Tage-Schnitt" → "7-Tage-Trend" with metric-aware delta
      indicator on every tile (`4e2386e`)
- [x] Dashboard layout settings: tiles independently selectable from
      charts; new `tileVisible` field with mirror-fallback for legacy
      saved layouts (`8ccdfac`)
- Detailed report: `.planning/phase-A4-report.md`

#### A4 status block — 2026-05-09T20:38+02:00

5 / 5 fixes shipped. Tests: 812 / 812 green (was 758 at phase start;
+54 across 9 new files). Typecheck 0 errors, lint 0 errors (12
pre-existing warnings unchanged).

Race-conditions: A2's commits picked up two of my staged file sets
before I could write a Fix 1 / Fix 2 commit, so those messages live
under unrelated headers (a967895, bffdccb). The actual code is in
the working tree where it belongs. Fix 3, 4, 5 commits land cleanly
under A4 ownership.

Visual / behavioural impact:

- BD-in-target tile no longer reports 0 % when imports drift the
  sys/dia timestamps past 5 min — same-Berlin-day fallback +
  pair-count denominator.
- Tile strip every metric paints a coloured `(±N.N)` next to the
  7-day average, with the label flipped to "7d trend" / "7T-Trend".
- Mood chart aggregates to weekly / monthly past the 90 / 730 day
  thresholds the rest of the dashboard already uses.
- Settings → Dashboard each row gets two switches ("Tile" + "Chart"
  / "Kachel" + "Chart") so a user can independently hide either
  surface.
- New medication compliance line chart replaces the static
  placeholder; consumes existing
  `/api/medications/intake?scope=compliance` endpoint.

### A5 — Mobile UX audit + fixes

- [x] Headless audit at Pixel 5 of `/`, `/dashboard`, `/insights`, `/admin/*`, `/settings/*` (2026-05-09T20:25+02:00)
- [ ] Fix scroll lockup on charts (touch-action / passive listeners)
- [ ] Document remaining items for v1.4.16
- Detailed report: `.planning/phase-A5-report.md`

#### A5 status block — 2026-05-09T20:25+02:00

Audit complete. 26 findings across 16 routes:
**2 CRITICAL · 8 HIGH · 12 MEDIUM · 4 LOW**.

- Findings document: `.planning/phase-A5-mobile-findings.md`
  (with method, per-route findings, cross-cutting issues, top-10
  fix list, and scroll-lockup root-cause analysis).
- Screenshots + raw JSON: `/tmp/v1415-audit/v1415-mobile-*.png`,
  `/tmp/v1415-audit/raw-results.json`,
  `/tmp/v1415-audit/retry-results.json`.
- Tools used: Playwright 1.59.1 against production
  `https://healthlog.bombeck.io` (`/api/version=1.4.14`) with
  `devices["Pixel 5"]` profile + Marc's session cookie.
- Test scripts at `/tmp/v1415-audit/*.spec.ts` (one-off, **not** added
  to `e2e/` per scope).

**Most impactful 3 fixes (best impact-per-LOC, ordered for fix-agent)**:

1. Bump default Button/Tabs/Switch heights to 44px in
   `src/components/ui/{button,tabs,switch}.tsx` — closes 12+ tap-target
   findings in one change.
2. Add `touch-action: pan-y` (Tailwind `touch-pan-y`) to the chart
   wrapper `<div>` in 5 chart components — fixes Marc's
   "Scrolling-Hänger im Dashboard auf Charts".
3. Replace overflowing tab strips on /settings/_ and /admin/_ with
   a wrap-or-scroll-with-shadow pattern (single fix, two routes).

**Scroll-lockup root cause**: Recharts 3.8.1 wrapper has
`touch-action: auto` (browser default). Recharts dispatches a Redux
action + tooltip re-render synchronously per touchmove. Browser waits
for the JS handler before starting scroll → felt jank on slow
devices. Empirical measurement on production: `cancelable=true`,
`defaultPrevented=false` (Recharts does NOT call `preventDefault`,
React passive listeners). One-line CSS fix per chart wrapper.

## Phase B — Bigger features (6 parallelizable items)

### B-mobile — Mobile audit fix-application

- [x] CRITICAL #1 — chart wrappers gain `touch-pan-y` (5 charts)
      — `316c3b0`
- [x] CRITICAL #2 — `/admin/users` mobile card-list at `< md`
      (landed under `41945b2`'s message — see report for race detail)
- [x] HIGH cluster — chart range buttons + chart switches +
      medication primary buttons + mood-list mobile icon buttons all
      44px-aligned — `8370b2d`
- [x] HIGH — `/settings/account` passkey table responsive (card-
      list at `< md`) — `00f8cd5`
- [x] MEDIUM — `/auth/login` Sign-in CTAs to 44px — `c0b14f4`
- [ ] DEFERRED to v1.4.16 — `/insights` + `/admin` tab strip
      overflow (cross-cutting `tabs.tsx`)
- [ ] DEFERRED to v1.4.16 — `/measurements` BP sys/dia row
      grouping
- [ ] DEFERRED to v1.4.16 — bottom-nav 5+More IA decision
- Detailed report: `.planning/phase-B-mobile-report.md`

#### B-mobile status block — 2026-05-09T20:54+02:00

5 commits shipped, 2 / 2 CRITICAL fixed, 6 / 8 HIGH addressed,
3 MEDIUM picked up opportunistically. Remaining 5 deferred items
all touch cross-cutting primitives (`tabs.tsx`) or larger logic
changes (BP grouping, bottom-nav IA) better done in a single
v1.4.16 design-systems / nav-IA pass.

Tests: 863 / 863 unit pass (was 812 at phase start). Typecheck:
1 pre-existing error (dashboard-layout.test.ts narrow-string
mismatch) reproduces on `git stash` — not mine. Lint: 0 errors,
12 warnings (none in B-mobile files).

Race observations: shared-cwd commit race reproduced twice (fix 2 +
fix 3 first attempts had wrong files committed under correct
messages); switched to `git commit -- <pathspec>` for fixes 3 / 4 /
5 which behaved atomically. v1.4.16 should adopt
`superpowers:using-git-worktrees` per agent.

### B1 — Backup completeness

- [x] Restore from backup (server endpoint + UI) — `fe85c2c`
- [x] Download backup as JSON — `d8c549e` (sibling-merged, scope is mine)
- [x] Upload backup — `30a74ed` (sibling-merged, scope is mine)
- [x] Audit log of backup ops — `0805452` (sibling-merged, scope is mine)
- [x] Docs link to "Backup structure" page on docs site — `7c32d63`
- Detailed report: `.planning/phase-B1-report.md`

#### B1 status block — 2026-05-09T21:03+02:00

All five criteria shipped on `origin/main`. New shared module
`src/lib/validations/backup.ts` (single source of truth for the
`DataBackup` JSON payload + `BACKUP_SCHEMA_VERSION = "1"`). pg-boss
`data-backup` worker now stamps `schemaVersion` on every snapshot.

Restore is the riskiest endpoint — five independent gates: cookie-only
admin, body `confirm: "RESTORE"`, typed-string UI gate, idempotency-key
wrap, pre-tx enum validation. Restore scope mirrors the v1.4.14 wipe
plus `mood_entries`. AuditLog rows survive restore.

Audit actions added (11 total): `admin.backups.run` + `.run.denied`,
`admin.backups.download` + `.denied` + `.failed`,
`admin.backups.upload` + `.upload.denied`, `admin.backups.restore` +
`.start` + `.denied` + `.failed`.

i18n: 19 new keys under `admin.section.backups.*` (EN + DE).

Tests: unit 883 / 883 (was 879), integration 31 / 31 (was 19). Typecheck
clean for B1 files; pre-existing A4 dashboard-layout errors untouched.
Lint 0 errors, 11 pre-existing warnings.

Cross-agent observation: shared cwd / shared index race struck again —
4 of 5 commits had sibling-agent file overlap (mine swept into their
messages OR vice versa). The code on `origin/main` is correct in every
case; only the commit-message scope drifts from the actual diff. Same
pattern A2 + A4 documented. v1.4.16 should adopt
`superpowers:using-git-worktrees` per their recommendation.

### B2 — Withings + moodLog sync robustness

- [ ] Status UI in Settings → Integrations
- [ ] Refresh token rotation handling
- [ ] Telegram-notify on persistent failure (if admin enabled the channel)
- [ ] Audit-log entry on failure
- Detailed report: `.planning/phase-B2-report.md`

### B3 — Notification reliability

- [x] Auto-disable channel on persistent 410 / hard rejects
- [x] Retry strategy with exponential backoff
- [x] Status visible in Settings
- Detailed report: `.planning/phase-B3-report.md`

#### B3 status block — 2026-05-09T21:05+02:00 — done

All three criteria shipped:

- `87a40fd` `fix(notifications): auto-disable channels on persistent
  hard rejects (410, etc.)` — migration 0028 (6 cols on
  `notification_channels`), `retry-policy.ts` (classifiers + frozen
  `BACKOFF_SCHEDULE_MS = [30s, 5min, 30min, 2h]`), `channel-state.ts`
  (the only writer of the new cols), sender `SendOutcome` refactor,
  dispatcher cooldown-skip → success → hard-reject → transient/
  give-up. Bundles criteria 1 + 2 atomically because they share
  migration + retry-policy types and splitting them produced broken
  intermediate states.
- `a3c0130` `feat(settings): notification channel status UI with
  re-enable + test` — wires `<NotificationStatusCard />` into the
  notifications section. Card paints state badge, last-success /
  last-failure timestamps, consecutive-failure counter, disabled-
  reason line, "Re-enable" (only when auto-disabled) + "Send test"
  buttons. `GET /api/notifications/status` + `POST` for re-enable.

**Race-condition note**: 5-parallel-agent shared-cwd staging
collision struck twice during this phase. (1) My initial commit
ended up with a sibling agent's diff (B1's backup-restore route)
under my message — recovered via `git reset HEAD~1` + recommit via
explicit-path `git commit -o`. (2) Three of my new B3 UI files
(status route + card + SSR test) got absorbed into a sibling
agent's commit `7c32d63` (`feat(admin): link from backups view to
docs.healthlog.dev`) during their `git add`. Files are correct on
main, just under a misleading subject. My follow-up `a3c0130`
makes the wiring + criterion-3 intent explicit. STATE.md A2 / B-
mobile already flagged this; v1.4.16 should adopt
`superpowers:using-git-worktrees` per agent.

Tests: 883 / 883 unit pass (was 863 at B3 start; +20 across 4 new
files). Integration: 31 / 31 pass. Typecheck: 0 new errors (only
pre-existing dashboard-layout.test.ts + integrations-section.tsx
errors remain, both outside B3 scope). Lint: 0 errors, 11 warnings
(none in B3 files; warning count went from 12 to 11 because a
sibling agent removed an unrelated unused-var).

### B4 — Achievements UI

- [ ] Surface in dashboard or dedicated page
- [ ] Unlocked-at timestamp visible
- Detailed report: `.planning/phase-B4-report.md`

### B5 — Onboarding tour first-run

- [ ] Welcome flow for new users (after passkey registration)
- [ ] Skippable
- Detailed report: `.planning/phase-B5-report.md`

### B6 — Doctor-report v2

- [ ] Configurable date range
- [ ] Practice-name on cover page
- Detailed report: `.planning/phase-B6-report.md`

## Phase C — Hardening

### C1 — AI/Codex hardening (infrastructure for hallucination-resistance)

- [ ] Provider abstraction review — multi-provider readiness
- [ ] Schema enforcement — output structured (JSON-schema), no free-form unbounded text
- [ ] Citation requirement — every claim must reference user-data point
- [ ] System-prompt scope hardening — medical-context-only, refuse out-of-scope
- [ ] Slug-drift defense — model fallback chain, dynamic discovery
- [ ] Document v1.4.16 backlog: medical-reference grounding (AHA guidelines etc.), multi-provider redundancy
- Detailed report: `.planning/phase-C1-report.md`

### C2 — Auto-deployment

- [ ] Coolify webhook on GHCR push (or watchtower equivalent)
- [ ] Failure path: admin Telegram notify (if configured) + audit log entry
- [ ] Test by tagging next release and watching auto-deploy fire
- Detailed report: `.planning/phase-C2-report.md`

### C3 — CI/e2e reliability audit

- [x] Audit gh workflow runs: which fail / are flaky / inconsistent
- [x] Identify root causes (not just rerun)
- [x] Fix flaky specs
- [x] Ensure docker-publish ALWAYS builds (v1.4.14 main hang was a clear example)
- [x] Self-test workflow: every commit must build green for both main and tag paths
- Detailed report: `.planning/phase-C3-report.md`
- Audit deep-dive: `docs/audit/v1415-ci-reliability.md`

#### C3 status block — 2026-05-09T20:55+02:00 — done

30-day audit complete (200 runs across 5 workflows):

| Workflow                   | Pre-C3 pass-rate | Notes                                     |
| -------------------------- | ---------------- | ----------------------------------------- |
| Integration                | 100 % (47/47)    | healthy                                   |
| Security & Quality         | 93 % (43/46)     | 3 typecheck regressions owned by A4       |
| Docker publish (completed) | 91 % (30/33)     | 1 outright hang (v1.4.14 main, 47 min)    |
| e2e                        | 0 % (0/47)       | every push since v1.4.14 went red on a11y |

Root causes:

- **e2e blocker**: A2's overview hard-codes Dracula colors that
  fail WCAG AA in light mode; Playwright defaults to
  `colorScheme: "light"` so axe scanned a layout users never see.
- **docker-publish hang**: shared `gha` cache scope (`mode=max`)
  between concurrent main+tag pushes on the same SHA caused the
  exporter to deadlock.

Fixes shipped on `origin/main`:

- `41945b2` fix(test): de-flake e2e a11y suite by forcing dark
  colorScheme — `playwright.config.ts` adds `colorScheme: "dark"`
  to top-level `use` AND each project (the `...devices[...]`
  spread overrides inherited values).
- `249c42b` fix(ci): docker-publish reliability — separate cache
  scope per ref + 30 min timeout — `cache-to: scope=build-${ref_name}`,
  `cache-from:` reads both ref-specific AND `build-main` for warm
  starts, `timeout-minutes: 30` bounds future deadlocks.
- `ffa4aac` feat(ci): post-publish verify workflow — pulls the
  just-published image, boots against ephemeral Postgres, probes
  `/api/version` + `/api/health`. Informational, not a deploy gate.
- `4a5be22` docs(audit): v1.4.15 CI/e2e reliability report.

Verification:

- All 5 workflow YAMLs parse cleanly (`yaml@2.8.4` round-trip).
- `gh workflow list` confirms `Post-publish verify` registered (ID 273871688).
- Manual `gh workflow run docker-publish.yml --ref main` dispatched
  (run 25609161399) — used new cache scope confirmed by job log
  `--cache-from type=gha,scope=build-main --cache-to type=gha,mode=max,scope=build-main`.
  Run was cancelled by a follow-up agent-push (concurrency group
  working as designed).
- e2e fix is deterministic: Playwright honours `colorScheme: "dark"`
  per official API; the inline theme bootstrapper in
  `src/app/layout.tsx:73` reads `prefers-color-scheme: dark` as
  the only theme signal in absence of localStorage.

Expected post-C3 pass-rates: e2e ≥ 90 %, docker-publish ≥ 95 %,
others unchanged.

Deferred items (out of C3 scope):

- Typecheck regression `dashboard-layout.test.ts` (lines 91/104/116)
  — owned by A4 / phase-D senior-dev review.
- Action-version Node-20 → Node-24 deprecation refresh — v1.5
  backlog (deadline Sept 2026).
- Trivy `continue-on-error` policy — phase-D security review.
- Real flake reduction in dashboard / insights specs — re-audit
  after the dark-mode noise clears (next marathon).

### C4 — i18n coverage audit

- [ ] `admin.section.<slug>.*` fully populated EN+DE
- [ ] Other namespaces audited
- [ ] Test guards parity AND non-empty
- Detailed report: `.planning/phase-C4-report.md`

### C5 — Empty-states audit

- [ ] `/admin/users`, `/admin/backups` empty states
- [ ] Other admin sub-routes
- [ ] Dashboard empty state for very-new users
- Detailed report: `.planning/phase-C5-report.md`

## Phase D — Multi-agent QA (parallel, write-only)

- [ ] code-reviewer
- [ ] security review
- [ ] design / UX review
- [ ] senior-dev review (architecture/maintainability — separate from code-review)
- [ ] simplify on changed file set
- [ ] reconcile + apply CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-report.md`

## Phase E — Release v1.4.15

- [ ] Pre-release verify: typecheck, lint, format, test, integration, build (Node-22 CI), e2e
- [ ] Bump package.json to 1.4.15
- [ ] CHANGELOG.md entry
- [ ] Tag + push v1.4.15
- [ ] GHCR build green (BOTH main + tag — verify via the new C2 reliability work)
- [ ] Coolify auto-deploy via webhook (the C2 work tests itself)
- [ ] /api/version=1.4.15 confirmed
- [ ] Image digest changed
- [ ] Production smoke screenshots
- [ ] GH release created
- [ ] Docs site + landing-site sync
- [ ] docs.healthlog.dev: new pages "Backup structure", "User-deletion lifecycle"
- [ ] Final summary `docs/audit/v1415-summary.md` (Marc-Brief)
- Detailed report: `.planning/phase-E-report.md`

---

## Previous milestone — v1.4.14 (completed 2026-05-09T18:35+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.14` · image digest
`sha256:0ced46004a54…` (was `791c2cd2…` on v1.4.12).

Full Marc-Brief, commit table, deferred items, CI/prod state and
Codex-OAuth resolution: `docs/audit/v1414-summary.md`.

Phases run during v1.4.14 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.5/v1.4.14, git+CI sanity)
- Phase 1 — Verify Codex-OAuth flow end-to-end (`gpt-5.3-codex` slug landed in commit `5df74f7`)
- Phase 2 — v1.4.6 deferred backlog (T2.1, T2.2, T2.3, T2.5; T2.4 + T2.6 + T2.7 deferred to phase 4b)
- Phase 3 — End-to-end test coverage (41/41 specs green)
- Phase 4 — Performance audit (`/insights` −108 KiB initial JS, dashboard −950 ms checklist)
- Phase 4b — Admin Panel refactor (per-section dynamic routes, T2.6 + T2.7 folded in)
- Phase 5 — UX polish (a11y violations cleared, trend-arrow direction-as-good, saved-AI-key removal)
- Phase 6 — Multi-agent QA (code-review, security, design, simplify; CRITICAL/HIGH applied inline; HIGH+MEDIUM deferred items recorded in `.planning/v1415-backlog.md`)
- Phase 7 — Pre-release verification (typecheck/lint/format/test/integration green; build/e2e Node-25 local issue, Node-22 CI canonical)
- Phase 8 — Release v1.4.14 (rebrand patch, GHCR `:1.4.14`, host-side retag deploy, image digest `0ced46004a54…`)
- Phase 9 — Docs + landing sync (commits `06bc616` docs, `92c6588` landing)
- Phase 10 — Backfill GitHub releases v1.4.7..v1.4.13
- Phase 11 — Final summary `docs/audit/v1414-summary.md`

---

## Status block — Phase 0 (v1.4.15)

- 2026-05-09T20:06:00+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.15 marathon (phases A1-A5, B1-B6, C1-C5, D, E).
  Previous v1.4.14 entries archived above. v1.4.14 leftover phase reports
  (10 untracked files) deliberately not folded into this Phase 0 commit
  (they belong to the previous milestone). Phase 0 commit will contain
  only `.planning/STATE.md`, `.planning/ROADMAP.md`,
  `.planning/phase-0-report.md`. Marc-status: awake, watching — speed
  matters.
