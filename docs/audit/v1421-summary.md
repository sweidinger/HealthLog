# HealthLog v1.4.21 — release summary

## Release brief

v1.4.21 ships as a same-day patch on top of v1.4.20 to fix a regression in the Insights redesign and tighten the AI Coach so it actually answers the questions it now invites. Five issues hit production within hours of the v1.4.20 tag, four of them user-reported, one surfaced in the post-deploy check. Daily Briefing regenerate was the headline: clicking "Re-run analysis" produced no briefing because `/api/insights/generate` was still calling the legacy system prompt, which never asks the model for a `dailyBriefing` block. The Coach felt generic because the snapshot it shipped to the model was aggregates only — the model honestly told users it could not isolate weekday-specific questions because it had no day-level data. Both are fixed. The Coach now carries day-level readings tagged with weekday, the regenerate path uses the strict-schema prompt, the duplicate streaming bubble is gone, the settings cog moved out from under the drawer's close-X, and the sources rail finally exposes the per-source toggles + window selector that the artboard always promised. Verdict: v1.4.21 makes v1.4.20 land as intended.

## Live state

| Field | Value |
|---|---|
| URL | `https://healthlog.bombeck.io` |
| `/api/version` | `1.4.21` |
| Image digest | `sha256:4e818d44702c3581a14d6480a953fd20d16cbbaf21c41e0c778c07340d3c4b1c` |
| Version transition | 2026-05-10T17:46:xx (host-side retag fallback) |
| GH release | https://github.com/MBombeck/HealthLog/releases/tag/v1.4.21 |
| Branch model | first patch through `develop` → `main` release-merge model (introduced in v1.4.20 F1) |

## Smoke (no session)

`/api/version` → 200 (returns `1.4.21`). Every gated route (`/`, `/insights`, `/insights/report/2026-W19`, `/admin/api-tokens`, `/settings/integrations`, `/achievements`) returns 307 → `/auth/login`, confirming the proxy gate is alive on the new image.

## What shipped

**Daily Briefing regenerate fixed.** The `/api/insights/generate` route called `getInsightsSystemPrompt` (legacy v1.4.5 schema, no briefing block) so manual regeneration always wrote a payload without a `dailyBriefing`. Switched to `getStrictInsightsSystemPrompt(locale)` so the v1.4.20 GROUND RULE 8 applies on every call. Cached legacy blobs still parse cleanly — the schema fields are optional, the SSE stream simply renders the empty state until the next regeneration produces one.

**Coach context now carries day-level readings.** `buildCoachSnapshot` ships a `timeline.recent` block (one row per UTC day for the last 14 days, weekday-tagged) and a `timeline.weekly` block (ISO-week buckets covering the rest of the analysis window). Per-day medication adherence rows come straight from `MedicationIntakeEvent`. The EN + DE Coach system prompts grew a DAY-LEVEL READINGS section telling the model to answer weekday questions out of `timeline.recent` with explicit date + weekday citations, fall back to `timeline.weekly` for older windows, and acknowledge missing days plainly instead of apologising about aggregate-only context. Token cost per Coach turn rises from ≈190 tokens (aggregates only) to ≈3000 tokens for a full-scope snapshot. The scope picker is the relief valve.

**Per-source + per-window scope picker on the Coach sources rail.** The rail grew real checkboxes (BP / Weight / Pulse / Mood / Compliance) at a 36px touch target with 60% opacity when excluded, and a window selector (7d / 30d / 90d / all-time). The drawer owns the scope state and forwards it through `useSendCoachMessage` to the chat request body. Toggles reset to "all sources, last 30d" on each drawer open. A single-source last-7-days narrowed turn lands around ≈600–700 tokens.

**Duplicate streaming bubble fixed.** After `done`, the streaming hook keeps `streaming.content` populated for the in-flight render path, then fires the TanStack invalidate that pulls the persisted assistant message into the conversation cache. The thread rendered the reply twice until the next `send` reset cleared it. The render path now suppresses the in-flight bubble as soon as the persisted twin lands, keyed on `streaming.messageId`.

**Settings cog vs Sheet close-X collision fixed.** Radix Sheet paints its default close-X at `top-4 right-4`, which visually swallowed the cog in the right-edge button cluster. The cog moved to the left header zone next to the gradient avatar; a `pr-12 / sm:pr-14` padding rule keeps the New-chat button out of the close-X area on narrower viewports.

**Suggested-prompt chips meet the 36px touch target.** Chips were rendering at 28px, below the WCAG-AA target-size guideline. Padding bumped to a 36px hit area.

## Token-budget tradeoff

The day-level snapshot makes the Coach actually personal at the cost of higher per-turn token usage. For a heavy user (full-scope, last 30 days), the budget shifts from ≈13 to ≈8 turns/day at the existing 25k tokens-per-user-per-day cap. The scope picker is the explicit lever: a single-source 7-day narrow turn is ≈600 tokens, leaving plenty of room for a long conversation about a specific metric.

## Quality

- 7-commit fix wave on `develop` (`7921ffc` regenerate prompt, `ed61b17` snapshot day-level, `2143377` system-prompt instruction, `f07e35b` streaming bubble, `ddb2914` cog vs close-X, `08fd411` scope picker, `52dd9ff` planning record)
- 1-commit release-prep on `develop` (`9955288 chore(release): v1.4.21`)
- Release-merge `8e198e1 Release v1.4.21` on `main`
- Tests: 2026 → 2036 unit (+10), 81 / 81 integration unchanged, typecheck clean, lint baseline (13 warnings, no new)

## Carry-overs

The Coolify "image-digest auto-deploy" bug is still present — the queued deploy completed in 17 seconds without a real `docker pull`, so `:latest` stayed pinned to the v1.4.20 digest in the local Docker cache. Worked around with the host-side retag procedure (`docker pull :1.4.21 → docker tag :latest → docker compose up -d --force-recreate`) on apps-01. Same fault that hit v1.4.19 + v1.4.20. The watchtower-via-Coolify path or the Coolify image-digest checkbox remain the durable fixes; tracked in the v1.4.21 backlog.

The e2e workflow on `main` reported 7 failing specs after the v1.4.20 tag. Five are stale selectors from the B1 hero rewrite (`[data-slot="insights-page-hero"]` no longer exists; the new `<HeroStrip>` exposes a different slot), the other two are layout drift on Pixel-5. A focused fix wave is in flight on `develop`; the next release will land them.

## Strategic next

v1.5 plan in `.planning/phase-D-v1420-product-lead-review.md` (iOS native client + Apple Health ingest contract, Coach extension for HRV / Sleep / Resting HR / Steps, per-metric APNs alerts, OpenAPI spec drift CI gate). v1.4.22 will pick up the e2e fix wave plus whatever else lands on the v1.4.21 backlog.
