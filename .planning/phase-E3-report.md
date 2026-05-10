# Phase E3 — Docs + Landing Sync (v1.4.16)

Completed 2026-05-10 ~03:55 CEST. Two repos touched, three commits, both pushed.

## healthlog-docs (commits on origin/main)

- `8addef4 chore(release): document v1.4.16 highlights` — 9 existing pages
  refreshed.
  - `features/ai-insights.mdx` — five new sections (per-recommendation
    explainability, confidence score, was-this-helpful feedback,
    medical-reference grounding, multi-provider fallback chain). 10/h
    rate-limit + cache-evict-on-regen documented.
  - `features/dashboard-customization.mdx` — Apple-Health-style chart
    polish (gradient + animation + personal baseline + rich tooltips +
    explicit empty state) and the comparison-overlay toggle. 7-day
    trend label normalisation called out.
  - `features/health-metrics.mdx` — comparison-overlay link added to
    the trend-analysis section.
  - `features/export-import.mdx` — new Settings → Export menu (5
    cards, audit-log entry per export, shared 10/h bucket).
  - `features/doctor-report.mdx` — entry-point relocated under
    Settings → Export.
  - `features/gamification.mdx` — dashboard preview now shares the
    achievements-page data source.
  - `configuration/admin-settings.mdx` — host-load chart, app-log
    preview, AI-quality preview, audit-log filtering + CSV export, and
    new section table rows for /admin/app-logs, /admin/audit-log,
    /admin/ai-quality.
  - `self-hosting/updates.mdx` + `self-hosting/scaling.mdx` — image
    tag bumped 1.4.15 → 1.4.16.
- `2a5802b docs: add deep-dive pages for AI insights, comparison
views, and provider config` — three new long-form pages plus
  Starlight sidebar wiring.
  - `insights/how-it-works.mdx` — end-to-end walk-through of the
    recommendation card, the deterministic confidence computation,
    fallback-chain hard-fail policy, what "low confidence" means, how
    feedback is used today + planned, and per-user privacy.
  - `dashboard/comparison.mdx` — toggle UX, forward-shift overlay
    semantics, what vs.-last-month / vs.-last-year actually compute,
    sparse-data handling, and deferred follow-ups.
  - `settings/ai-providers.mdx` — setup paths for all five providers
    (Codex / OpenAI direct / Anthropic / local / admin-shared), the
    fallback-chain editor, test-connection button, credential storage
    table.
- Astro build green: 44 pages built, all three new routes generated
  (`/insights/how-it-works/`, `/dashboard/comparison/`,
  `/settings/ai-providers/`), pagefind index green.
- Push: `db66da0..2a5802b main -> main` to
  `github.com:MBombeck/healthlog-docs.git`.

## healthlog-landing (commit on origin/main)

- `3d17207 chore(release): v1.4.16 version label + AI insights
mention` — `softwareVersion` bumped 1.4.15 → 1.4.16; JSON-LD
  feature list gains 5 new entries (multi-provider fallback,
  explainability, confidence score, medical-reference grounding,
  chart polish, comparison overlays); hero AI-insights card copy
  rewritten as "AI insights that show their work" leading with
  explainability + confidence + citations; capability-badges row
  picks up two new badges. `pnpm build` green.
- Push: `b6f83be..3d17207 main -> main` to
  `github.com:MBombeck/healthlog-landing.git`.

## Main HealthLog repo

Untouched per scope (this phase reads only).

## Notes

- No "Claude / AI / agent / marathon / phase" leak in any docs or
  landing copy.
- No --no-verify / --no-gpg-sign — neither repo has pre-commit hooks
  configured today, so nothing was bypassed.
- Co-Author trailer present on all three commits.
