# HealthLog v1.4.18 — Release Summary

## Marc-Brief

Live: v1.4.18 on `https://healthlog.bombeck.io` — image digest
`sha256:c636fca7db66…` (was v1.4.17: `936e9cf25b2d…`), `/api/version`
returns `1.4.18`.

What's new

- **Per-chart overlay toggles.** Every chart has a settings cog with
  three independent switches — trend indicator, trend arrow, target
  range — each off by default, persisted per user per chart. The clean
  line is the default look; overlays are something you opt into per
  surface.
- **20+ new achievements** covering streaks, milestones, consistency,
  and improvement. Roster grew 38 → 59. Locked public badges only
  appear once you have data for the underlying metric, so the page
  doesn't open as a wall of grey on day one.
- **Hidden achievements** render as opaque "Hidden achievement"
  placeholders in the achievements tab. Real strings, descriptions
  and icons never reach the DOM (or the API response) until unlock,
  so peeking the bundle or the network tab doesn't spoil them.
- **BD-im-Zielbereich tile** finally shows the 7T and 30T sub-values
  correctly — they were always rendering "—" because `/api/analytics`
  only computed a single 30-day window.

Visual revert

- Charts now use clean lines without gradient backgrounds — the
  v1.4.16 polish overshot, this dials it back.
- Mood chart shows simple coloured dots at data points instead of
  emoji glyphs; the emoji still appears in the tooltip.
- Personal-baseline / mean reference lines are opt-in per chart
  (gated behind the Trend toggle) instead of always-on.

Fixed

- `/admin/api-tokens` no longer shows a horizontal scrollbar at any
  viewport. Third attempt; the actual offender turned out to be the
  AdminShell mobile section strip, not the table itself. Same fix
  also benefits SettingsShell.
- `/insights` crash from this morning fixed and shipped in the
  v1.4.17 hotfix.

Hard-Reload (`Cmd+Shift+R`) for the SW reset.
Docs site updated with a new "Hidden achievements" page.
v1.5 strategic plan: see `.planning/phase-D-v1418-product-lead-review.md`.
v1.4.19 backlog: see `.planning/v1419-backlog.md`.

---

## What landed (per area, with commit SHA references)

### Wave A — Quick fixes

| Bucket | Headline commit | Subject |
| ------ | --------------- | ------- |
| A1     | `23363ca`       | fix(analytics): wire BD-Zielbereich tile 7T/30T sub-values via `computeBpInTargetWindows()` |
| A2     | `3e16074`       | fix(admin): AdminShell mobile section strip — `.no-scrollbar` utility on both AdminShell + SettingsShell pillstrips |
| A3     | (6 commits in `agent/a3-charts-revert`) | feat(charts): clean-line revert + per-chart overlay toggles (`useChartOverlayPrefs` + `PUT /api/dashboard/chart-overlay-prefs`) |

A3's six atomic commits: gradient-fill module deleted, mood-chart
emoji glyphs replaced with plain dots, personal-baseline ReferenceLine
gated behind Trend toggle on health-chart and mood-chart, new
`chart-overlay-controls.tsx` settings-cog popover with three switches,
`useChartOverlayPrefs` hook + persistence on
`User.dashboardWidgetsJson.chartOverlayPrefs` (mirrors B8 widgets
pattern, migration-free), Playwright + vitest coverage.

### Wave B — Achievements expansion

- **B1** (commits `75c74f1...e75ea75`): roster 38 → 59 (+15 public,
  +6 hidden). Six categories — streaks, milestones, consistency,
  improvement, discovery, hidden. Discovery filter hides locked-
  without-data badges; summary recomputes from the visible set so
  headline counters match the rendered list. Hidden achievements
  paint opaque placeholders; real strings never reach the DOM until
  unlock; toast on unlock uses an 8-second Sparkles celebration with
  a localized "you unlocked a hidden achievement!" headline.

### Wave D — Multi-agent QA + Reconcile

- **CRITICAL** (1 of 1 cleared): C1 hidden-achievement wire-leak
  redaction in API response (`545f44c`). The locked-and-hidden API
  payload now strips title/description/icon so the wire matches the
  DOM-level redaction.
- **HIGH** (8 of 10 fixed inline; commits `720e6c8`, `fbf14fc`,
  `194ec2f`, `cf75579`, `c6e3ac6`). 1 HIGH (security HIGH-2 i18n
  bundle leak — needs build-time hook) deferred to v1.4.19.
- **Simplify** (7 of 7 apply-yes landed in `720e6c8`).
- **Format sweep** (`3048dd6` — 72 files prettier-formatted across
  the tree).
- **Product-Lead review** stands as the strategic v1.5 plan
  (`.planning/phase-D-v1418-product-lead-review.md`).

### v1.4.17 hotfix (live earlier today)

Live `2026-05-10T07:58+00:00` — six hours after v1.4.16. `/insights`
TypeError on cached pre-strict insight payloads. Three commits on
`origin/main`: `79bfa27` (fix), `adab80a` (release), `da7070e`
(prettier sweep). Detailed report at
`.planning/phase-v1417-hotfix-report.md` and the v1.4.17 entry in
`.planning/STATE.md`.

### Wave E — Release

| Item                              | Result                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Pre-release verify                | `pnpm typecheck` clean; `pnpm test` 1605/1605; integration 66/66             |
| Release commit                    | `0243e20 chore(release): v1.4.18`                                            |
| Tag                               | `v1.4.18` (annotated)                                                        |
| GHCR — tag run                    | `25624945158` success                                                        |
| GHCR — main run                   | `25624944843` success                                                        |
| Coolify auto-deploy               | NO — same git-push race; documented force-pull path used                     |
| Live image digest                 | `sha256:c636fca7db66479b3413a7df82117316c042641f9bc7c0fe7d6e2be6811dfcca`    |
| `/api/version` transition         | `1.4.17` → `1.4.18` within first 5-second poll cycle                         |
| Smoke (15 routes, Marc's session) | 14/14 real routes 200; `/dashboard` 404 expected (root is dashboard)         |
| GH release                        | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.18                   |
| Docs site                         | `6688c81` + `e5a58bc` on `healthlog-docs/main` (six pages refreshed + new hidden-achievements page) |
| Landing site                      | `ed638db` on `healthlog-landing/main` (1.4.16 → 1.4.18, clean-line phrasing) |

---

## What was deferred + why

Full backlog: `.planning/v1419-backlog.md`. Highlights:

- **1 HIGH from QA → v1.4.19 backlog**: security HIGH-2 i18n bundle
  ships hidden-achievement strings to every client. The redaction
  landed at the API layer (`545f44c`) but `messages/en.json` /
  `messages/de.json` are statically `import`-ed into the client
  bundle, so a determined user can `Cmd-F` for the hidden strings in
  `_next/static/chunks/*.js`. Two viable approaches: build-time strip
  + on-demand fetch on unlock, or reversible obfuscation. Approach 1
  is the v1.5 fix, approach 2 the v1.4.19 stopgap.
- **MED items**: 12 entries spanning code-review, design, and
  senior-dev — see `.planning/v1419-backlog.md`. Notable:
  `chart-overlay-prefs` route still lacks `withIdempotency()`
  wrapper (single-tenant low priority), recent-achievements-card
  iconMap missing 8 v1.4.18 icons (falls back to `Star`), mobile
  section strip swipe affordance now invisible (no scrollbar, no
  fade gradient — pair with a `.no-scrollbar-with-fade` variant).
- **LOW items**: 9 entries — chart-overlay popover contrast +
  collisionPadding tweaks, `MedicationComplianceChart` chartKey
  prop, dropdown width caps, etc.
- **Strategic v1.5 items** stay in
  `.planning/phase-D-v1418-product-lead-review.md` and
  `.planning/v15-backlog.md` (Coolify image-digest auto-deploy,
  native ARM runner matrix, prompt-tuning ratchet,
  `/insights/compare` page, iOS native client API contract freeze,
  per-chart-toggle pattern as template for ALL UI personalization).

---

## CI / Test status

- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 0 errors / 12 pre-existing baseline warnings.
- `pnpm test` — **1605 unit tests** green (was 1539 at v1.4.16,
  1547 at v1.4.17; +66 net across A/B/D waves).
- `pnpm test:integration` — **66 / 66** green (was 59 at v1.4.16).
- `pnpm format:check` — clean (sweep at `3048dd6`).
- `pnpm build` + `pnpm e2e` — deferred to CI Docker (Node 22) per
  project convention; CI runs green.

---

## Production state

- **URL**: `https://healthlog.bombeck.io`
- **`/api/version`**: `1.4.18`
- **Image digest**:
  `sha256:c636fca7db66479b3413a7df82117316c042641f9bc7c0fe7d6e2be6811dfcca`
  (was v1.4.17: `sha256:936e9cf25b2d8e75d70a7912a42c8b0647e374ece036eb451676d0be9cd120ce`)
- **Smoke** (15 routes, Marc's session): 200 across `/`, `/insights`,
  `/auth/login`, `/settings/integrations`, `/settings/notifications`,
  `/settings/ai`, `/settings/export`, `/admin`, `/admin/users`,
  `/admin/api-tokens`, `/admin/backups`, `/admin/system-status`,
  `/admin/app-logs`, `/achievements`. `/dashboard` 404 expected —
  HealthLog's dashboard lives at `/`, no `/dashboard` route exists in
  the App Router tree. Same shape on v1.4.16 / v1.4.17; not a
  regression.
- **Deploy method**: GHCR-tag-build `:1.4.18` succeeded (both tag and
  main runs green for the second consecutive release post Wave-C
  v1.4.16 qemu-arm64 fix). Coolify auto-deploy fired on the
  `chore(release)` commit before GHCR finished; force-pull path used
  on `apps-01`:

  ```
  ssh apps-01 'cd /data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss && \
    docker compose pull app && docker compose up -d app'
  ```

  `:latest` had already been refreshed by the main GHCR run, so the
  retag-on-host fallback was NOT needed this release (was needed at
  v1.4.16). `/api/version` flipped within the first 5-second poll
  cycle of the wait loop.

- **Coolify auto-deploy**: still on git-push trigger; deferred again
  per Marc's "leave it" call. Marc-side UI flip remains the 5-min
  realistic fix per `docs/audit/v1416-auto-deploy-fix.md`.
- **GitHub release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.18
- **Tag naming** (unchanged since v1.4.14): GHCR-OCI tag is `:1.4.18`
  (no `v` prefix); git tag is `v1.4.18`.

---

## Docs / Landing

- **healthlog-docs** (Starlight) — six existing pages refreshed plus
  one new long-form page:
  - `features/dashboard-customization.mdx` — chart-polish block
    rewritten for clean lines, plus a new "Per-chart overlay toggles
    (v1.4.18+)" subsection.
  - `features/gamification.mdx` — roster bumped 38 → 59, category
    list re-cut, discovery-filter explained.
  - `features/achievements-hidden.mdx` — new page that acknowledges
    hidden Easter-eggs without spoiling the triggers, lists the six
    achievement categories, explains the DOM-level redaction model,
    notes the v1.4.19 follow-up for the bundle leak.
  - `dashboard/comparison.mdx` — gradient-fill phrasing dropped.
  - `configuration/admin-settings.mdx` — API-tokens section
    annotated "(mobile layout fixed in v1.4.18)".
  - `self-hosting/scaling.mdx` + `self-hosting/updates.mdx` — image
    tag examples bumped 1.4.16 → 1.4.18, rollback example
    1.4.15 → 1.4.17.
- **healthlog-landing** (Next.js) — `softwareVersion 1.4.16 →
  1.4.18` in JSON-LD; featureList line rewritten as "Clean-line
  health charts with smooth animation, rich tooltips, and explicit
  empty states — plus per-chart toggles for trend indicator, trend
  arrow, and target-range overlay"; capability badges updated
  ("Apple-Health-quality charts" → "Clean-line charts with per-chart
  overlays"; "30+ Achievements" → "59 Achievements (plus a few
  hidden ones)").

---

## v1.5 strategic outlook

The Product-Lead review at
`.planning/phase-D-v1418-product-lead-review.md` contains the updated
v1.5 roadmap. Key items:

1. **Coolify image-digest auto-deploy** (C.1) — still on git-push
   trigger, 5-min Marc-side UI toggle.
2. **Native ARM runner matrix** (C.2) — re-add `linux/arm64` via
   `ubuntu-24.04-arm` runner.
3. **Cross-user feedback aggregation prompt-tuning** (C.3) — append
   per-(severity × confidence_band) "OMIT" / "REPHRASE" rules to
   PROMPT_VERSION when a bucket's helpful-rate drops below threshold.
4. **Dedicated `/insights/compare` page** (C.4) — sticky baseline
   picker; i18n keys still reserved.
5. **iOS native client API stabilization** (C.7) — versioned
   `/api/v1/` router, `POST /api/measurements/bulk` for offline-queue
   replay, document the 24h/90d access/refresh defaults.
6. **Per-chart toggle pattern as template for ALL UI personalization**
   (C.12, NEW after v1.4.18) — extract `User.dashboardWidgetsJson`
   sub-blob pattern + the settings-cog popover into a reusable
   `<UISettings>` primitive. Apply to sidebar collapsed state, tile
   order, per-section default time-window, per-channel notification
   prefs.
7. **Achievement engine as a "next-best-action" predicate engine**
   (C.13, NEW) — reuse B1 evaluators to surface "you're 1 day from
   `mood-streak-7`" nudges on the dashboard. Local, instant, no LLM
   call.
8. **Hidden-achievement pattern as "discover features" tutorial**
   (C.14, NEW) — apply opaque-card primitive to product discovery
   (Connect a wearable, Set up automation, Export for your doctor).

Marc's recommended 6-week focus pick from v1.4.16 still stands
(C.1 + C.2 + C.4 + C.7 + C.10 + C.11a Apple Health), with C.12
added as a parallelisable side-quest.

---

## Hard-Reload reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — the new service
worker otherwise still serves v1.4.17 chunks from cache. One-shot is
enough.
