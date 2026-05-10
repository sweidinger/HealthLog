# Phase A3 — Chart visual revert + per-chart toggles

Status: complete
Date: 2026-05-09T10:36:00+02:00
Branch: agent/a3-charts-revert (merged to origin/main)

## Scope

Roll back three pieces of v1.4.16 phase B1a that Marc rejected after
seeing them live, and replace them with a per-chart switch surface so
each overlay can be opted into independently and persists per user.

Hard NO list (memory `feedback_charts_visual_identity.md` v1.4.18):
1. Gradient area fills under chart lines.
2. Smiley/emoji glyphs on the mood chart's data points.
3. Always-on personal-baseline / mean reference line.

Hard YES list:
- Per-chart switches for "7-Tage-Trend / Trend-Pfeil / Zielbereich".
- Default state of every switch is OFF; clean line is the new default.

## Commits on origin/main

1. `revert(charts): remove gradient background fills (clean lines only)`
   — strips the `<defs><linearGradient>` blocks and `<Area fill=...>`
   primitives from every chart wrapper; deletes the unused
   `chart-gradient.tsx` module + its test.
2. `revert(charts): mood chart shows simple dots instead of emoji at data points`
   — drops the emoji glyph map and the SVG `<text>` dot factory. The
   mood line paints plain Recharts dots, the y-axis already labels
   each integer (very low / low / okay / good / great), so the chart
   stays scannable without a glyph.
3. `revert(charts): remove auto-overlay personal baseline (now opt-in via Trend toggle)`
   — gates the 90-day-rolling-median ReferenceLine behind the Trend
   toggle on both HealthChart and MoodChart, matching Marc's rule that
   the mean only paints when a trend is actively being shown.
4. `feat(charts): per-chart overlay-controls component with 3 toggles`
   — new `chart-overlay-controls.tsx`: settings-cog dropdown anchored
   in each chart card with three independent switches. Full EN+DE
   i18n under `chart.overlay.controls.*`.
5. `feat(charts): persist per-chart overlay prefs (default off; clean line)`
   — extends `User.dashboardWidgetsJson` with `chartOverlayPrefs` per
   the v1.4.16 phase B8 pattern (no Prisma migration), adds
   `PUT /api/dashboard/chart-overlay-prefs` for partial updates,
   protects the existing PUT `/api/dashboard/widgets` from wiping prefs
   on widget-only saves, threads a `useChartOverlayPrefs` hook through
   HealthChart / MoodChart / MedicationComplianceChart, and plumbs
   `chartKey="bp|weight|pulse|mood|medications"` through the
   dashboard page so each instantiation binds to its own persisted
   slot.
6. `test(charts): coverage for revert + overlay-controls + persistence`
   — adds a Playwright e2e spec (open the popover, toggle target-range,
   verify the PUT round-trip fires) and a vitest SSR test pinning the
   medication chart's trend-chip gate.

## Architectural deviations from the brief

The brief lists five chart wrapper files (`blood-pressure-chart.tsx`,
`weight-chart.tsx`, ...). The actual codebase consolidates BP / weight
/ pulse / body-fat / sleep / steps into a single `HealthChart` wrapper
parametrised by the `types` array. Same deviation B1a's report
documented; one wrapper edit covers all those families.

The brief proposes a dedicated `User.chartOverlayPrefs` column. We
extended `User.dashboardWidgetsJson` instead, mirroring the v1.4.16
phase B8 comparison-baseline pattern. Migration-free, identical shape
on the wire.

## Test deltas

- 5 new vitest tests: overlay-defaults (2), overlay-controls (4),
  medication overlay-toggles (2), dashboard-layout chartOverlayPrefs (4).
- 1 new integration test: `chart-overlay-prefs.test.ts` (2 cases —
  persist + reject unknown chart key).
- 1 new Playwright spec: `chart-overlay-controls.spec.ts`.
- 4 existing chart tests had their `vi.mock("@tanstack/react-query")`
  blocks extended to expose `useQueryClient` + `useMutation` so the
  charts that now depend on the persistence hook still SSR cleanly.

Final state: `pnpm test` 1569/1569, `pnpm test:integration` 63/63,
`pnpm typecheck` clean, `pnpm lint` 0 errors / 12 pre-existing
warnings.

## Hand-off

The new EN+DE i18n keys live under `chart.overlay.controls.*` —
visible to design / Wave D as part of the audit surface.
`CHART_OVERLAY_KEYS` in `src/lib/dashboard-layout.ts` is the
single-source-of-truth for which charts have a persisted overlay
slot; new charts get a slot by adding a key there and threading
`chartKey={...}` through their dashboard mount.

The work was carried out in worktree `../HealthLog-a3` on branch
`agent/a3-charts-revert`; six atomic commits were pushed to origin/main
via rebase-and-fast-forward, with `pnpm test && pnpm test:integration
&& pnpm typecheck && pnpm lint` clean before each push.
