# HealthLog v1.4.19 — Release Summary

## Marc-Brief

Live: v1.4.19 (image digest `sha256:b48f93874cdb…`, `/api/version=1.4.19`)

Fixed

- BD im Zielbereich now shows independent values for 7T / 30T / total
  (was identical because the headline aliased the 30-day percentage)
- `/admin/api-tokens` table — no horizontal scrollbar at any viewport
  (4th attempt — truncate-with-tooltip)
- Charts on mobile no longer break the layout when the period chip +
  range tabs combine
- `/insights` raw `metric: blood_pressure_sweet` template leak fixed

Polish

- Settings/Integrations: single status pill top-right (Withings + Mood
  Log) — no more redundant containers
- `/insights` single page-level refresh button
- Comparison toggle removed from dashboard, kept only on `/insights`
- AI prompt: no default "data foundation is strong" opener
- Settings input heights, spacing, action-button positions consistent
  across all sub-routes mobile + desktop
- Zielwerte status labels in German
- 6 CRITICAL + 21 HIGH copy / consistency / a11y fixes from a
  comprehensive audit

Hard-Reload (`Cmd+Shift+R`) for SW reset.
v1.4.20 next — full `/insights` redesign with AI Coach (plan in
`.planning/phase-D-v1419-product-lead-review.md`).
v1.5 reserved for iOS app + Apple Health.

---

## What landed (commit highlights per Wave)

### Wave A — bugs + polish

| Bucket | Headline commit | Subject |
| ------ | --------------- | ------- |
| A1 | `a856272` | fix(analytics): BD-Zielbereich headline routes through new `allTime` window in `computeBpInTargetWindows()` |
| A2 | `77a3ad3` + `a739085` | fix(charts): mobile-first header stack + universal x-axis tick density helper |
| A3 | `60a91af` / `98a3d10` / `335f288` / `fa91a73` | feat(insights): comparison toggle relocated to hero, single page refresh, BP/Weight tile strip removed, lowercase template-token leak fixed |
| A4 | `b5e9a95` | fix(ai): GROUND RULE 7 — no default-positivity opener; `PROMPT_VERSION` 4.16.1 → 4.19.0 |
| A5 | `ba0d6b8` / `0dcc91a` / `47a8fc7` | feat(settings): `<IntegrationStatusPill>` consolidates Withings + Mood Log status UI |
| A6 | `957f8e9` / `9fda634` / `1075784` / `737b533` / `78f1f3f` | fix(settings): mobile consistency sweep — input heights, action button placement, language select row |
| A7 | `088832a` / `dd8212e` / `7a70db6` / `6507646` / `90a109d` | fix(admin): feedback tab strip, api-tokens scrollbar 4th attempt, Einklappen removal, Zielwerte spacing + DE labels |

### Wave B — A8 quality findings applied

16 atomic commits — 6/6 CRITICAL + 21/25 HIGH — covering time-window
locale, login-overview auth filter, achievement title humanisation,
date-input `lang`, sidebar copy, raw enum badges, audit-action labels,
mobile Sys/Dia badge enum, telegram badge collapse, token name ISO
suffix, recent-activity row links.

### Wave D — multi-agent QA + reconcile

Six atomic commits cleared the post-Wave-B CRITICAL (mobile Sys/Dia
badge enum mismatch, `ef74241`), 5 simplify-yes consolidations
(`6b35cad`), and four HIGH fixes (`1258b24`, `5a8ad3d`, `977f124`,
`1f0d9ad`).

---

## What was deferred

Full backlog: `.planning/v1420-backlog.md`.

- **3 HIGH from QA** rolled into v1.4.20: D-CR-H-05
  (`/insights` `data?.` narrowing — large refactor), D-DSGN-H-01
  (api-tokens touch tooltip — needs Popover swap), D-DSGN-H-02
  (insights hero density — folded into the v1.4.20 redesign).
- **1 HIGH** to v1.5: D-SR-H-3 Withings / Mood Log card-chrome dedup —
  parked as Apple-Health-card-prep work in `.planning/v15-backlog.md`.
- **31 MED + 16 LOW** from the quality-of-life audit — short-list at
  `.planning/v1420-backlog.md`.
- **`/insights` redesign with AI Coach** — separate v1.4.20 roadmap;
  design handoff at `~/Downloads/design_handoff_insights_redesign`.
- **iOS app + Apple Health** — reserved for v1.5
  (`.planning/v15-backlog.md`).

---

## CI / Test status

- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 0 errors / 12 pre-existing baseline warnings (no new).
- `pnpm test` — **1672 / 1672** unit tests green (was 1605 at v1.4.18;
  +67 net across A1, A2, A3, A4, A5, A6, A7, B, and Phase D reconcile
  TDD additions).
- `pnpm test:integration` — **67 / 67** green (was 66 at v1.4.18; +1
  for A1's BD-Zielbereich `allTime` window guard).
- `pnpm format:check` — only pre-existing `.planning/*` +
  `docs/audit/*` baseline noise dirty (same call as v1.4.18 / v1.4.16;
  no source-tree drift).
- `pnpm build` + `pnpm e2e` — deferred to CI Docker (Node 22) per
  project convention; CI runs green on tag and main.

---

## Production deploy

| Field | Value |
| ----- | ----- |
| URL | `https://healthlog.bombeck.io` |
| `/api/version` | `1.4.19` (flipped at 2026-05-10T12:39:59Z) |
| Image digest BEFORE | `sha256:c636fca7db66479b3413a7df82117316c042641f9bc7c0fe7d6e2be6811dfcca` (v1.4.18) |
| Image digest AFTER | `sha256:b48f93874cdbcd6c2d729f1b8eeb63a6d1bbb90d56f629846ef6eab6cf272aa9` (v1.4.19) |
| Release commit | `89f00cf chore(release): v1.4.19` |
| Tag | `v1.4.19` (annotated) |
| GHCR — tag run | `25628853202` success |
| Coolify auto-deploy | NO — main-branch deploy hung and was canceled; host-side retag-on-host fallback used |
| Smoke (curl, Marc's session) | `/` 200 · `/insights` 200 · `/admin/api-tokens` 200 · `/settings/integrations` 200 · `/achievements` 200 · `/dashboard` 404 (expected — root is dashboard, no `/dashboard` route in App Router) |
| GH release | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.19 |
| Docs site | `6e8840e` on `healthlog-docs/main` (six pages refreshed) |
| Landing site | `dd5892f` on `healthlog-landing/main` (`softwareVersion` JSON-LD bumped) |

The tag-build pipeline succeeded; the main-branch deploy stalled and
was canceled, so v1.4.19 was promoted via the documented host-side
fallback path:

```
docker pull ghcr.io/mbombeck/healthlog:1.4.19
docker tag ghcr.io/mbombeck/healthlog:1.4.19 ghcr.io/mbombeck/healthlog:latest
docker compose up -d --force-recreate app
```

`/api/version` flipped to `1.4.19` on the first poll cycle after
recreate, well inside the 5-minute cap.

---

## v1.4.20 strategic preview

v1.4.20 is the full `/insights` redesign with an AI Coach surface —
strategic plan at `.planning/phase-D-v1419-product-lead-review.md`
(redesign brief, layout principles, 3 deferred HIGH items folded into
the new layout). v1.5 stays reserved for the iOS app + Apple Health
integration; design handoff at
`~/Downloads/design_handoff_insights_redesign`.

---

## Hard-Reload reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — the new service
worker otherwise still serves v1.4.18 chunks from cache. One-shot is
enough.
