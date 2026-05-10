# HealthLog v1.4.16 — Release Summary

## Marc-Brief

✅ Live: v1.4.16 on `https://healthlog.bombeck.io` — image digest
`sha256:05f8a126d639…` (was v1.4.15: `ace7d441f47b…`), `/api/version`
returns `1.4.16`.

🆕 **What's new**

- AI insights now show **WHY** each recommendation appears — data
  window, comparison, deviation — with a confidence meter and a
  thumbs feedback control on every rec.
- Medical citations on relevant recommendations (AHA / ESH / ESC /
  WHO / DGE), opening the source guideline in a new tab.
- Multi-provider AI fallback chain configurable in Settings → AI
  (Codex / OpenAI direct / Anthropic / Local / Admin OpenAI).
- Apple-Health-style chart polish: gradients, rich tooltips, in-target
  shading, 90-day median personal baseline, mood emoji glyphs.
- Comparison overlay on charts, tiles, and the AI summary: "vs. last
  month" / "vs. last year" with delta callout.
- New Settings → Export consolidates doctor-report PDF + measurements
  / medications / mood CSV + full JSON backup in one page.
- Achievements page (`/achievements`) plus dashboard preview card.
- Onboarding tour for new users (skippable, replayable).
- Admin host-load chart, app-log preview with JSON inspector, and
  AI-quality dashboard.
- Backup full lifecycle — restore, download, upload, audit trail.

🔧 **What's fixed**

- BD-Zielbereich percentage finally counts in-range readings (predicate
  was too narrow — was always 0% on normotensive data).
- Trend on "all" filter shows a meaningful split-half delta instead of 0.
- Top-tile selector actually filters now (widget enum bug; layout PUT
  silently 422'd).
- Login overview no longer strips umlauts ("Nürnberg", "München",
  "Düsseldorf", "Köln").
- `/admin/api-tokens` table is responsive on mobile (card list at <md).
- Skip-link no longer blocks logo click.
- Cached AI insights replaced when regenerated (no stale dashboard).

⚙️ **Infrastructure**

- `docker-publish` main-branch hang fixed — root cause was qemu-arm64
  SIGILL during multi-arch emulation; arm64 dropped from main publish.
  Native ARM runner matrix planned for v1.5.
- CI integration tests + e2e workflows green again.

⚠️ **Hard-Reload** (`Cmd+Shift+R`) for SW reset.
📚 **Docs site updated** — three new deep-dive pages: AI Insights —
How It Works, Comparison Views, Provider Configuration.
🎯 **v1.5 roadmap**: see `.planning/phase-D-product-lead-review.md`.

---

## What landed (per area, with commit SHAs)

### Wave A — Quick fixes

| Bucket | Commit             | Subject                                                                                    |
| ------ | ------------------ | ------------------------------------------------------------------------------------------ |
| A1     | `77fe256`          | fix(nav): admin sub-items don't expand from gravatar dropdown or admin-link click          |
| A2     | `577d8dd`          | fix(insights): BD-Zielbereich computes correctly for real measurement data                 |
| A3     | `277a5aa`          | fix(admin): api-tokens table no horizontal overflow on Pixel-5 viewport                    |
| A4     | `4df6dac`          | feat(charts): "7-Tage-Trend" rename + slope30 fallback for sparse metrics                  |
| A5     | `93e712d`          | fix(dashboard): top-tile selector persists (widget-id enum drift fixed)                    |
| A6     | `9b01c86`          | feat(charts): medication chart matches other charts (7d trend + indicator + target-range)  |
| A7     | (within `9b01c86`) | feat(insights): rate-limit 10/h + cache-evict on regenerate (cross-agent race captured A7) |
| A8a    | `2da0703`          | fix(geo): preserve umlauts in city names (login-overview no longer renders "Nrnberg")      |
| A8b    | `af77e5e`          | feat(charts): split-half mean delta on long-window trend                                   |

### Wave B — Quality-leap features

| Bucket | Headline commits                                                                            | What it does                                         |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| B1a    | `74c2eb8`, `901f44e`, `8008613`, `2611bb4`                                                  | BP / weight / pulse / mood / medication chart polish |
| B1b    | `4d7d074`, `9e8be4b`, `b76351e`, `0c287f1`, `d2cdf9d`, `5063ad7`, `3b0d21e`                 | `/insights` hero + recs grid + dashboard preview     |
| B2     | (worktree `agent/b2-ai-provider-ux` ff)                                                     | Single-pulldown Settings → AI + chain editor         |
| B3     | `5d1ece1`, `f1bd801`, `2877710`, (chart inside `8d9f864`)                                   | Admin host-load chart (in-process sampler, 7d)       |
| B4     | (audit-log inside `8ac5602`), `4cc3d8d`, `6520ae4`                                          | Admin audit-log filter + CSV + app-log preview       |
| B5a    | `27f3933`, `466b8b5`, `7fbfca6`, `53aade9`, `a66c128`                                       | Curated medical-reference bundle + citation footnote |
| B5b    | `2611bb4` (column), runner inside `901f44e`, `613d661`, `d2bda42`                           | Multi-provider fallback chain + last-working cache   |
| B5c    | `8a438a0`, `c39a527`, `13f1ae5`, `c8b30c1`, `7f54c0c`, `680f84c`, `10a67ff`, `fed2e7e`      | Per-rec rationale (window / comparedTo / deviation)  |
| B5d    | `0cb0373`, `af21d4d`, `7ec1030`, `63cfd8e`, `d343ab5`, `173c3e1`                            | Deterministic confidence meter (server-overrides)    |
| B5e    | `badc893`, `8255e3e`, `ca84fb7`, `47ca1e4`, `71ffe30`, `8879282`                            | RecommendationFeedback + daily aggregator + admin    |
| B6     | `01a05e4`, `a432cb2`, `ed0cfda`, `d914f76`                                                  | Settings naming audit + i18n parity guard            |
| B7     | `621109c`, `a512650`, `94c748d`, (routes inside `226cac4`), `d5c8912`, `830b2b0`, `e628f33` | Settings → Export consolidation                      |
| B8     | `775df8c`, `2cf7b74`, `e4a408e`, `f9f99ea`                                                  | Comparison overlay on charts + tiles + AI narration  |

### Wave C — Catch-up (deferred from v1.4.15)

| Item                                   | Commit    | Notes                                                          |
| -------------------------------------- | --------- | -------------------------------------------------------------- |
| CI fix (encryption-key + tour-overlay) | `fbcd106` | Both pre-existing red since `d8c549e`; both green from here on |
| H1 admin restore-failed scrub          | `fdac9e2` | code-review HIGH                                               |
| H2 moodEntry.tags JSON-array refine    | `7f1a4de` | code-review HIGH                                               |
| H4 tour-launcher per-user sessionKey   | `2afe3c4` | code-review HIGH                                               |
| H4 design 44 px tap targets sweep      | `b863e2c` | tour / backups / notifications                                 |
| i18n parity Quelle / Leitlinie         | `2a7ef72` | B5a follow-on                                                  |
| MED tabs horizontal scroll             | `d7c2b2a` |                                                                |
| MED bottom-nav 5+More                  | `072eee6` | overflow sheet                                                 |
| MED system-status retry button         | `65b4bf9` |                                                                |
| Auto-deploy v1.5 doc                   | `4be6465` | Coolify auto-deploy stays on git-push for v1.4.16; deferred    |
| docker-publish drop qemu-arm64         | `cc0f343` | qemu-SIGILL root cause; native-runner matrix in v1.5           |

5 of 8 deferred HIGH from v1.4.15 Wave-D landed; 3 of 5 deferred MED
from A5 mobile landed; Coolify image-digest auto-deploy deferred per
Marc's "leave it" call.

### Wave D — Multi-agent QA + Reconcile

- **CRITICAL** (3 of 3 cleared): C1 wired (`aae968a` —
  `<InsightAdvisorCard>` mounts on `/insights`), C2 wired
  (`8a5b6de` — `<InsightsCardPreview>` mounts on `/`), C3 on-surface
  comparison toggle (`6e74d38`).
- **HIGH** (9 fixed inline): `5f7b9d8`, `6863ecb`, `fb12f09`,
  `c3451a4`, `2f057f4`, `5661439`. 11 HIGH deferred to v1.5 backlog.
- **Simplify** (7 of 8 apply-yes landed): `f3025a8`. F1 + F8 are
  apply-no flagged for Marc.
- **Product-Lead review** stands as-is and IS the strategic v1.5 plan
  (`.planning/phase-D-product-lead-review.md`).
- Style cleanup: `c63cddc`.

### Wave E — Release

| Item                              | Result                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Pre-release verify                | `pnpm typecheck` clean; `pnpm test` 1540/1540; integration 59/59                     |
| Release commit                    | `d443c22 chore(release): v1.4.16`                                                    |
| Tag                               | `v1.4.16` (annotated)                                                                |
| GHCR — tag run                    | `25616783583` success, digest `2f1a0d6b381d…`                                        |
| GHCR — main run                   | `25616782255` success, digest `4841bef396ad…`                                        |
| Coolify auto-deploy               | NO — same race as v1.4.14/v1.4.15; retag-on-host fallback used                       |
| Live image digest                 | `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa`            |
| `/api/version` transition         | `1.4.15` → `1.4.16` at `2026-05-10T03:45:58+02:00`                                   |
| Smoke (14 routes, Marc's session) | 13/14 200; `/dashboard` 404 expected (root is dashboard)                             |
| GH release                        | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16                           |
| Docs site                         | `8addef4` + `2a5802b` on `healthlog-docs/main` (44 pages, three new deep-dive pages) |
| Landing site                      | `3d17207` on `healthlog-landing/main` (1.4.15 → 1.4.16, AI cards updated)            |

---

## What was deferred + why

Full backlog: `.planning/v15-backlog.md`. Highlights:

- **11 HIGH from QA → v1.5 backlog**: H3 strict B5b/B5c/B5d wiring
  into `/api/insights/generate`, H4 `findRecommendationsMissingRationale()`
  is a no-op on parsed payload, H7 comparison overlay single-period
  audit, H8 ai-section seedKey race-window, design H5 hero gradient
  bump, design H8 DE fallback-chain row overflow, senior-dev H1 (`src/lib/ai/`
  19 flat files re-shape), senior-dev H2 (`<InsightAdvisorCard>` 690 LOC
  god-component split), senior-dev H3 (`<RecommendationCard>` 417 LOC
  split), code-review H5 + H6 cumulative duplication. Sized in the
  product-lead review.
- **2 simplify-no items**: F1 `runWithFallback` test-only (delete and
  migrate or wire to strict variant — Marc's call), F8
  `RecommendationCard.normalise()` indirection (mechanical rewrite
  spans 8+ JSX sites).
- **Native ARM runner matrix** for `docker-publish` — qemu-arm64
  SIGILL forced amd64-only on main; native `ubuntu-24.04-arm` matrix
  is the v1.5 plan.
- **Coolify image-digest auto-deploy** — still on git-push trigger;
  deferred per Marc's "leave it" call. Marc-side UI flip is the 5-min
  realistic fix per `docs/audit/v1416-auto-deploy-fix.md`.
- **Cross-user feedback aggregation prompt-tuning ratchet** — B5e
  set up the storage and the daily aggregator; the prompt-mutation
  loop itself is v1.4.17 / v1.5 work.
- **Dedicated `/insights/compare` page** — B8 deferred this; the
  overlay-on-charts ships in v1.4.16. i18n keys
  `comparison.insightsCallout.{lastMonth,lastYear}` reserved so the
  future component drops in clean.
- **Senior-dev H1 + H2 splits from v1.4.15** — both still open;
  carry forward into v1.4.17 architectural pass.
- **Mood-chart H3 (chart-presentation) from v1.4.15** — chart-
  ownership rule keeps this with charts owners; pick up next time
  a chart-presentation pass runs.

---

## CI / Test status

- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 0 errors / 12 pre-existing warnings.
- `pnpm test` — **1539 unit tests** green (started v1.4.16 marathon
  at ~1048; +491 net across A/B/C/D/E waves).
- `pnpm test:integration` — **59 / 59** green (was 31 at v1.4.15).
- `pnpm format:check` — not in CI; new files prettier-formatted via
  `c63cddc` style sweep.
- `pnpm build` + `pnpm e2e` — deferred to CI Docker (Node 22) per
  project convention; CI runs green.

---

## Production state

- **URL**: `https://healthlog.bombeck.io`
- **`/api/version`**: `1.4.16` ✓
- **Image digest**:
  `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa`
  (was v1.4.15: `sha256:ace7d441f47bd8c69fd0c5e2417b7f6c53bc387aa10c9aa541ad5e6321e9581d`)
- **Smoke** (14 routes, Marc's session): 200 across `/`, `/insights`,
  `/auth/login`, `/settings/integrations`, `/settings/notifications`,
  `/settings/ai`, `/settings/export`, `/admin`, `/admin/users`,
  `/admin/backups`, `/admin/system-status`, `/admin/app-logs`,
  `/achievements`. `/dashboard` 404 expected — HealthLog's dashboard
  lives at `/` (PWA convention), there is no `/dashboard` route in
  the App Router tree (NOT a regression — same shape on v1.4.15).
- **Deploy method**: GHCR-tag-build `:1.4.16` succeeded (Wave-C C3
  fix dropped arm64 on main and made BOTH GHCR runs green for the
  first time since v1.4.13). Coolify auto-deploy fired on the
  `chore(release)` commit before GHCR finished and pulled the host's
  stale local `:latest` cache; retag-on-host fallback (`docker pull
:1.4.16 && docker tag :1.4.16 :latest && docker compose up -d app`)
  flipped `/api/version` 1 s after the up command returned.
- **Coolify auto-deploy**: still fires on every git-push (deferred
  per Marc's call); v1.5 plan in `docs/audit/v1416-auto-deploy-fix.md`.
- **GitHub release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16
- **Tag naming** (unchanged since v1.4.14): GHCR-OCI tag is `:1.4.16`
  (no `v` prefix); git tag is `v1.4.16`.

---

## Docs / Landing

- **healthlog-docs** (Starlight) — 44 pages, three new deep-dive
  routes:
  - `/insights/how-it-works/` — recommendation card walk-through,
    deterministic confidence computation, fallback hard-fail policy,
    "low confidence" semantics, feedback usage today + planned,
    per-user privacy.
  - `/dashboard/comparison/` — toggle UX, forward-shift overlay
    semantics, what vs.-last-month / vs.-last-year actually compute,
    sparse-data handling, deferred follow-ups.
  - `/settings/ai-providers/` — setup paths for all five providers,
    fallback-chain editor, test-connection, credential storage table.
- **healthlog-landing** (Next.js) — `softwareVersion 1.4.15 →
1.4.16` in JSON-LD; AI-insights hero card rewritten as "AI insights
  that show their work" leading with explainability + confidence +
  citations; capability badges row picks up two new badges.

---

## v1.5 strategic outlook

The Product-Lead review at `.planning/phase-D-product-lead-review.md`
contains the full v1.5 roadmap and is the strategic plan for v1.5.
Top items to look at:

1. **Coolify image-digest trigger** (C.1) — replaces git-push churn.
   5-min Marc-side UI toggle.
2. **Native ARM runner matrix** (C.2) — re-add `linux/arm64` to
   GHCR matrix via native `ubuntu-24.04-arm` runner.
3. **Cross-user feedback ratchet → prompt-tuning** (C.3) — append
   per-(severity × confidence_band) "OMIT" / "REPHRASE" rules to
   PROMPT_VERSION when a bucket's helpful-rate drops below threshold.
4. **Dedicated `/insights/compare` page** (C.4) — sticky baseline
   picker + `aiInsightResponseSchema.comparison` field +
   `<InsightsComparisonCallout>` above the recs grid.
5. **iOS native client API contract freeze** (C.7) — versioned
   `/api/v1/` router, `POST /api/measurements/bulk` for offline-queue
   replay, document the 24h access / 90d refresh defaults so iOS
   doesn't surprise-fail at 24h+ε.
6. **Apple Health import via iOS** (C.11a) — XML parse + map +
   bulk endpoint; the natural pipe is the iOS app.
7. (See review §C.5 streaming + A/B + per-user prompt prefix, §C.6
   charts library decision, §C.8 security hardening sweep, §C.9
   performance, §C.10 S3 backup push, §C.11 Garmin / Oura
   integrations.)

Marc's recommended 6-week focus pick from the review: **C.1 + C.2 +
C.4 + C.7 + C.10 + C.11a Apple Health**.

---

## Hard-Reload reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — the new service
worker otherwise still serves v1.4.15 chunks from cache. One-shot is
enough.
