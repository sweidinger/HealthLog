# Phase E3 — docs + landing sync (v1.4.19)

Status: ok / 2026-05-09. One commit per repo on origin/main.

## healthlog-docs (commit `6e8840e`)

Single commit `chore(release): document v1.4.19 highlights`. Six
files touched, all pre-existing pages — no new pages in v1.4.19:

- `self-hosting/updates.mdx` + `self-hosting/scaling.mdx` — three
  docker image tags bumped 1.4.18 -> 1.4.19 (single-container,
  app-web, app-worker).
- `configuration/admin-settings.mdx` — api-tokens row in the admin
  console table notes the v1.4.19 desktop-table no-scrollbar fix
  (truncate-with-tooltip + `table-fixed` colgroup widths).
- `features/integrations.mdx` — "Connection Status" retitled
  "v1.4.15+, consolidated in v1.4.19", explains the new single
  status pill + Withings / Mood Log divider parity; redundant
  banner trio + bottom-of-card "letzter Sync" line gone.
- `features/dashboard-customization.mdx` — BD-Zielbereich tile gets
  a sentence on the v1.4.19 fix (`allTime` window via
  `computeBpInTargetWindows()`); new "Mobile chart layout (refined
  in v1.4.19)" subsection covers the mobile-first header stack +
  `useViewportWidth` hook + tick-density helper (4/6/8/10 caps).
- `features/ai-insights.mdx` — new "Prompt Tone (v1.4.19)" section
  on GROUND RULE 7 + PROMPT_VERSION 4.19.0.

No standalone "current version" surface or roadmap section in the
docs site, so no v1.4.20 teaser added.

## healthlog-landing (commit `dd5892f`)

Single one-line commit bumping `softwareVersion` in JSON-LD from
`1.4.18` to `1.4.19`. Feature copy untouched per brief — v1.4.20
will overhaul the page itself.

## Constraints honoured

English, Marc's voice, no AI / agent / marathon / phase mention. No
`--no-verify`, no `--no-gpg-sign`. Co-Author trailer present on
both commits. Main HealthLog repo untouched.
