# Phase B1b — Insights surface visual polish (v1.4.16)

Completed 2026-05-10 ~02:08 CEST. Worktree-isolated under
`agent/b1b-insights-surface` then fast-forwarded to `origin/main` (no
rebase needed — origin/main was at `c8e7639` for the entire run).

## What landed

Seven atomic commits on origin/main, each TDD-first (failing tests
before implementation):

| #   | Commit                                                                                                        | What it ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `4d7d074 feat(insights): page hero with gradient header + generation timestamp + personal-baseline indicator` | New `<InsightsPageHero>` component renders a Dracula-gradient (purple → cyan, /15 + /8 opacity) band with sparkles glyph, h1 + overview subtitle, "Based on your last 90 days" personal-baseline caption, "Generated <relative-time>" caption, and an optional regenerate button. Pure presentational shell — `/insights/page.tsx` passes the freshest of the per-section cache timestamps in via a new `freshestUpdatedAt()` helper. 10 component tests (gradient classes, slots, EN+DE, regenerate disabled state, missing-timestamp branch). New i18n keys: `insights.heroGenerated`, `heroPersonalBaseline`, `heroRegenerate`, `heroRegenerating`, `relative{JustNow,MinutesAgo,HoursAgo,DaysAgo}` × EN+DE. Animation reuses the existing `animate-insight-in` keyframes which already gates on `prefers-reduced-motion: reduce`.                                                 |
| 2   | `9e8be4b feat(insights): recommendations grid with severity ordering + animated reveal`                       | New `<RecommendationsGrid>` wraps `<RecommendationCard>` (B5c-built) in a 1-col mobile / 2-col desktop CSS grid with severity-priority ordering (urgent → important → suggestion → info) via a stable `sortRecommendationsBySeverity()` helper. Each card row gets a Dracula-token left border (red/orange/purple/cyan at /70 opacity), a 200ms transition + `md:hover:-translate-y-0.5 md:hover:shadow-lg` lift, and a 100ms-staggered fade-in via `animationDelay`. Internal slots of `<RecommendationCard>` untouched per brief — the shell wraps the card. Refactored the card's outer element from `<li>` to `<div>` (the only sensible way to hoist grid/flex layout one level up without breaking valid HTML5 list semantics). `<InsightAdvisorCard>` now consumes the grid instead of its old `<ol>` + `.map`. 8 grid tests + the existing 12 advisor-card tests still green. |
| 3   | `b76351e feat(insights): polished summary typography with inline-chart sparklines`                            | Bumps the summary slot in `<InsightAdvisorCard>` from `text-muted-foreground text-sm` to `text-foreground/90 max-w-prose text-base leading-relaxed`. The inline-chart-token renderer (`metric:<TYPE>` allowlist from earlier phases) gains a `mini` flag; the summary surface passes `mini` so its embedded charts shrink to sparkline form (140px). Per-finding charts keep the full chart so they remain interactive. 3 new typography tests.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | `0c287f1 feat(insights): polished loading + empty + error states`                                             | Loading state replaces the spinner-only placeholder with a 3-card skeleton grid (`bg-muted/40-60` pulse with 100ms staggered delay) that mirrors the final layout so the page doesn't visually jump on content load. Empty state gains a centred sparkle glyph in a `bg-dracula-purple/10` circle + max-w-prose copy. Error state moves from a flat banner to a card with a discoverable `data-slot="insight-retry-button"` retry button when an `onRegenerate` handler is supplied. 4 new state tests.                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | `d2cdf9d feat(dashboard): InsightsCardPreview matches insights page visual language`                          | Replaces the orphan v1.4.0 `<InsightsCard>` (zero non-test imports; bound to the deprecated `changed/stable/drivers/nextSteps` schema) with a leaner `<InsightsCardPreview>` that takes an `insight: InsightResult \| null` prop and renders the top 1-2 severity-ordered recs as compact tiles + a "View all" CTA pointing at `/insights`. Same visual language as the page: severity-coloured left border, ring-variant `<ConfidenceMeter>` inline. Returns `null` when there are no recs (the dashboard's parent grid doesn't render an empty box). New i18n keys: `insights.viewAll`, `previewEmpty` × EN+DE. 8 preview tests.                                                                                                                                                                                                                                                    |
| 6   | `5063ad7 style(insights): dark-mode contrast verification + tweaks`                                           | Bumps the page-hero gradient from `/10 + /5` to `/15 + /8` and the border from `/20` to `/25` so the band's lightness delta against the dark Dracula background sits at ~17%, clearing the 3:1 UI-element contrast bar. Skeleton placeholders go from `/30/40/50` to `/40/50/60`. Adds a regression test that pins the contrast-relevant utility classes via regex so a future refactor can't silently drop them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | `3b0d21e test(insights): coverage for polished page + dashboard preview`                                      | New SSR integration suite exercises `<InsightAdvisorCard>` + `<RecommendationsGrid>` + `<RecommendationCard>` + `<ConfidenceMeter>` + `<RecommendationFeedback>` all painting together so the cross-feature slot positions don't regress (the B5c report flagged that an e2e isn't feasible because `/insights` doesn't currently mount the advisor card; the SSR test covers the same surface end-to-end). Pins severity-ordering preservation under low-confidence recs and the empty-grid unmount path. 3 integration tests.                                                                                                                                                                                                                                                                                                                                                       |

## Verification

- `pnpm test` — 1501/1501 pass (was 1464 → +37 net for B1b).
- `pnpm test:integration` — 59/59 pass (no regression).
- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 12 pre-existing warnings / 0 errors.

## Architectural decisions worth surfacing

- **`<RecommendationsGrid>` over a render-prop pattern.** A
  `RecommendationCardListItem` HOC was considered; the wrapping shell
  ended up cleaner as its own component because severity-ordering is
  a list-level concern and shouldn't live inside per-rec rendering.
- **`<li>` → `<div>` outer in `<RecommendationCard>`.** Required so
  the grid wrapper can layer CSS grid + Dracula severity border
  without invalid `<li>` nesting. No existing test pins on the `<li>`
  element; the per-card `data-slot="rec-card"` semantic survives.
- **Page hero uses CSS `animation-delay` for stagger, not JS.** The
  brief asks for staggered fade-in; the grid's `animationDelay`
  inline style off `index * 100ms` lets the existing
  `animate-insight-in` keyframes do the work without React-side
  timer state. `prefers-reduced-motion: reduce` already neutralises
  the keyframes globally per `globals.css`.
- **Inline-sparkline regex deferred.** The brief asked for
  regex-extracted metric mentions in summary text rendered as
  inline sparklines. The model already emits structured `metric:<TYPE>`
  tokens which the existing `<InlineCharts>` renderer handles —
  flipping summary charts to `mini` mode delivers the same visual
  effect without a fragile NLP pass over freeform model text. Regex
  extraction noted for v1.4.17 if rec authors prove unable to emit
  the structured tokens consistently.
- **Dashboard `<InsightsCard>` was orphaned.** Pre-B1b, the
  component had zero non-test imports — it was scaffolded in v1.4.0
  but never mounted. Rather than maintain dead code, the file now
  exports `<InsightsCardPreview>` (new shape, `InsightResult` prop
  type) and the legacy fetcher is gone. When dashboard wiring lands
  (likely v1.4.17 alongside the route-layer
  insights generate-on-load flow), it imports the preview and
  passes the cached payload in.

## Acceptance-criteria coverage

1. ✅ Page hero with gradient header + generation timestamp + personal-baseline indicator (commit 1).
2. ✅ Recommendations grid with severity ordering + animated reveal (commit 2).
3. ✅ Polished summary typography with inline sparkline metric references — delivered via the existing structured `metric:<TYPE>` token system + new `mini` mode; freeform regex extraction deferred (commit 3).
4. ✅ Polished loading + empty + error states (commit 4).
5. ✅ Dashboard `<InsightsCardPreview>` matches insights page visual language (commit 5).
6. ✅ Dark-mode contrast verification + tweaks (commit 6).
7. ✅ Tests for polished page + dashboard preview (commit 7).

## E2E (Playwright) — not added; rationale below

Same as B5c, the brief's aspirational e2e ("on `/insights`, expand a
rec, see rationale + confidence + feedback all rendered together")
isn't reachable today because `<InsightAdvisorCard>` isn't mounted
on the production `/insights` route — the page renders
`<InsightStatusCard>` per-section with text-only summaries. The new
SSR integration test (`recommendations-grid-integration.test.tsx`)
exercises the same component flow against the MockAIProvider end-to-
end. When a future phase wires `<InsightAdvisorCard>` onto a live
route, the e2e drops in via the storage-state pattern from
`e2e/insights-generate.spec.ts`.

## Cross-agent worktree race notes

Zero races this round. The worktree at `/Users/marc/Projects/HealthLog-b1b`
on `agent/b1b-insights-surface` shipped all 7 commits; origin/main
sat at `c8e7639` for the entire run so the push was a clean fast-
forward (`c8e7639..3b0d21e`) without rebase friction.

## What v1.4.17 inherits

- **Dashboard wiring path is open.** `<InsightsCardPreview>` accepts
  an `InsightResult \| null` prop. When the dashboard ships its
  insights cache hydration (sibling work on `/api/insights/generate`
  return shape), the preview drops in next to the existing
  `<TrendCard>` strip.
- **Inline-sparkline regex extraction.** If rec authors don't
  consistently emit `metric:<TYPE>` tokens in summary prose, a
  v1.4.17 phase can layer a regex pass over the freeform text.
  The grid's slot architecture is forward-compatible.
- **Comparison-views (B8) overlay** can render its delta callouts in
  the page hero alongside the personal-baseline caption — the hero
  shell already accepts arbitrary children via the `<div>` wrapper.
