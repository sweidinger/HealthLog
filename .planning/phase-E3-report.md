# Phase E3 — Docs + Landing sync (v1.4.18)

Status: complete · 2 commits on healthlog-docs, 1 commit on
healthlog-landing, both pushed to origin/main.

## healthlog-docs

Two commits on `origin/main`:

- `6688c81 chore(release): document v1.4.18 highlights` — six
  existing pages refreshed.
- `e5a58bc feat(achievements): hidden achievements page` — new
  long-form page plus its sidebar entry in `astro.config.mjs`.

Pages touched in commit `6688c81`:

1. `features/dashboard-customization.mdx` — rewrote the
   "Apple-Health-style chart polish" block. Gradient fills are gone,
   the mood chart shows plain dots instead of emoji glyphs (the emoji
   still appears in the tooltip), and a new "Per-chart overlay toggles
   (v1.4.18+)" subsection documents the cog menu with the three
   switches (trend / trend arrow / target range), defaults-off
   behaviour, and per-chart-per-user persistence on
   `User.dashboardWidgetsJson.chartOverlayPrefs`.
2. `features/gamification.mdx` — bumped roster from 38 → 59,
   re-cut the category list (medication / vitals / mood / engagement
   / security / bug / hidden), called out the v1.4.18 discovery filter
   that hides locked badges for metrics with no data, and pointed at
   the new hidden-achievements page.
3. `dashboard/comparison.mdx` — dropped the "gradient fill" phrasing
   from the prior-period-line description so the page is consistent
   with the new clean-line aesthetic.
4. `configuration/admin-settings.mdx` — annotated the API tokens
   section row with "(mobile layout fixed in v1.4.18)".
5. `self-hosting/scaling.mdx` — bumped the
   `ghcr.io/mbombeck/healthlog:` example tags from `1.4.16` to
   `1.4.18`.
6. `self-hosting/updates.mdx` — same image tag bump for the pinning
   example, and the rollback example refreshed `1.4.15` → `1.4.17`
   so it points at the immediately-previous release.

New page in commit `e5a58bc`:

- `features/achievements-hidden.mdx` — acknowledges the hidden
  Easter-egg achievements without spoiling the triggers, lists the
  six categories the Achievements page groups by (streaks /
  milestones / consistency / improvement / discovery / hidden),
  explains the DOM-level redaction model (the page never reads the
  real strings for `hiddenLocked: true`), and notes the v1.4.19
  follow-up for the `messages/{en,de}.json` bundle leak. Wired into
  the Features section of the sidebar via `astro.config.mjs`.

The v1.4.16 "AI Insights — How It Works" page (`insights/how-it-works.mdx`)
was reviewed for chart-gradient or smiley-glyph mentions; it has none,
so no edit was needed there.

Verification: `npm run build` — 45 pages built, 0 warnings, the new
`/features/achievements-hidden/index.html` renders, pagefind search
index covers it.

## healthlog-landing

One commit `ed638db chore(release): v1.4.18 version label + cleaner
chart phrasing` on `origin/main`.

- `softwareVersion` in the JSON-LD `SoftwareApplication` block
  (`src/app/layout.tsx`) bumped from `1.4.16` to `1.4.18`.
- The featureList line "Apple-Health-quality charts with gradient
  fills, smooth animation, personal 90-day baseline, rich tooltips,
  and explicit empty states" rewritten to reflect the v1.4.18
  aesthetic — "Clean-line health charts with smooth animation, rich
  tooltips, and explicit empty states — plus per-chart toggles for
  trend indicator, trend arrow, and target-range overlay".
- Two capability badges in `src/app/page.tsx` updated:
  "Apple-Health-quality charts" → "Clean-line charts with per-chart
  overlays"; "30+ Achievements" →
  "59 Achievements (plus a few hidden ones)".

Verification: `pnpm build` — Next.js static export green, single
`/` page prerendered as expected.

## Push status

- `healthlog-docs`: `2a5802b..e5a58bc  main -> main`
- `healthlog-landing`: `3d17207..ed638db  main -> main`

No `--no-verify` / `--no-gpg-sign` flags used; neither repo has
pre-commit hooks configured today, so nothing was bypassed.
Co-Author trailer (`Claude Opus 4.7 (1M context)`) present on all
three commits. The HealthLog main repo, the iOS app, and the
`-audit-fixes` worktrees were not touched, per the brief's
constraints.
