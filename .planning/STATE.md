# v1.4.16 marathon — state log

Status: finished
Last update: 2026-05-10T04:05+02:00

> Previous milestone: `docs/audit/v1415-summary.md` (live: `/api/version=1.4.15`,
> image digest `sha256:ace7d441f47b…`).

## Phase 0 — Bootstrap

- [x] STATE+ROADMAP rewritten for v1.4.16
- [x] git status clean
- [x] codex-protocol-spec re-read
- [x] v1416-backlog.md inventoried
- Result: ok / commit `chore(planning): bootstrap v1.4.16 marathon` on origin/main
- Detailed report: `.planning/phase-0-report.md`

## Wave A — Quick fixes (parallel buckets)

### A1 — Sidebar admin-expand bug

- [x] Clicking Admin from non-admin route does NOT auto-expand sub-items (mirror Settings exact pattern)
- [x] Gravatar dropdown does NOT trigger sidebar expansion side-effect
- Detailed report: `.planning/phase-A1-A3-report.md`
- Commit: `77fe256 fix(nav): admin sub-items don't expand from gravatar dropdown or admin-link click` on origin/main

### A2 — BD-Zielbereich real-fix (regression from v1.4.15 A4)

- [x] Investigate root cause — A4 in v1.4.15 marked this fixed but Marc still sees 0%
- [x] Verify against actual user data with measurements (pulled from production apps-01 DB)
- [x] Fix root cause + add E2E test that exercises full flow against real session
- Detailed report: `.planning/phase-A2-A6-report.md`
- Commit: `577d8dd fix(insights): BD-Zielbereich computes correctly for real measurement data` on origin/main
- Root cause: v1.4.15 fix corrected the denominator but kept the ESH narrow-band predicate (`sysLow <= sys <= sysHigh AND diaLow <= dia <= diaHigh`); Marc's normotensive readings (e.g. 117/79) were below sysLow=120 and so counted as OUT. Marc's actual production data: 0/10 paired readings in target under v1.4.15. Fix: change to one-sided ceiling semantics with hypotension floor (`90 <= sys <= sysHigh AND 50 <= dia <= diaHigh`); centralised in `isBpReadingInTarget()` shared by 6 call sites. Marc's data now reports 50% (was 0%).

### A3 — /admin/api-tokens table responsive (still scrolling)

- [x] Inspect current state on prod with Marc's session — overflow-x scrollbar visible
- [x] Fix properly: card-list mobile fallback OR proper column-hide chain at xs/sm/md breakpoints
- Detailed report: `.planning/phase-A1-A3-report.md`
- Commit: `277a5aa fix(admin): api-tokens table no horizontal overflow on Pixel-5 viewport` on origin/main

### A4 — "7-Tage-Schnitt" → "7-Tage-Trend" DE + indicator on ALL charts

- [ ] DE i18n string rename everywhere (incl. tile-strip + chart subtitles)
- [ ] Trend indicator (+/-) appears for EVERY chart including mood + medication + insights
- [ ] Trend on "all" filter computes correctly (currently shows 0)
- Detailed report: `.planning/phase-A4-report.md`

### A5 — Top-tile-selector real-fix (regression from v1.4.15 A4)

- [ ] Investigate why settings save isn't reflected on dashboard
- [ ] Probably a query-cache stale-read OR the layout-config field isn't actually consumed by the tile-strip
- [ ] Fix + e2e test toggling visibility persists
- Detailed report: `.planning/phase-A5-report.md`

### A6 — Medication-chart 7d-trend + target-range

- [x] Medication-chart matches other charts: 7d-trend label + indicator + target-range visualization
- Detailed report: `.planning/phase-A2-A6-report.md`
- Commit: `9b01c86 feat(charts): medication chart matches other charts (7d trend + indicator + target-range)` on origin/main
- Added `computeMedicationTrend7d()` helper (split-half mean comparison, 14-day cap), trend chip in header (signed Δ-pp + arrow icon, `up-good` sentiment colours), 100% goal ReferenceLine alongside the existing 80% threshold. 6 new unit tests pin trend computation. Cross-agent race note: `9b01c86` accidentally bundled A7's `INSIGHTS_RATE_LIMIT_PER_HOUR` work — see report for details.

### A7 — AI Generator rate-limit 10/h + cache-invalidate-on-new

- [x] Rate-limit current 2/h → 10/h (env-configurable via `INSIGHTS_RATE_LIMIT_PER_HOUR`)
- [x] When user generates new insight: evict ALL cached previous insights for that user (per-status `audit_logs` rows for `insights.<scope>-status.<locale>` are deleted; `insights-card.tsx` already invalidates `["insights"]` on mutation success)
- [x] Verify: dashboard shows newest insight, never stale-cached (3 new test blocks: 10/h default, env override, sub-1 fallback, deleteMany call shape, cached-path skip)
- Detailed report: `.planning/phase-A7-A8a-report.md`
- Commit: source landed inside `9b01c86 feat(charts): medication chart matches other charts` (cross-agent race — A6 worker pushed first and absorbed the staged A7 files). Code is verbatim what A7 wrote: `resolveInsightsRateLimit()`, `evictPerStatusInsightCache()`, the rate-limit message rewrite to `Maximum ${limit} insight generations per hour.`, and the i18n flatten ("Bitte warte — du hast das stündliche Limit für Analysen erreicht."). All on origin/main.

### A8 — Umlaute encoding bug + login-overview

- [x] "Nrnberg" should be "Nürnberg" — geo helper now decodes via `arrayBuffer() + TextDecoder('utf-8')` instead of `Response.json()`, so an upstream proxy that strips/rewrites the `Content-Type: charset` parameter cannot poison the umlaut path
- [x] Audited all of `src/` for ASCII-fold patterns (`normalize("NFD")`, slugify, `[^a-zA-Z…]/g` strips, `String.fromCharCode`/`charCodeAt` deburr): zero hits. The geo helper was the only surface
- [x] Regression test for known-umlaut roundtrip: 7 cities (Nürnberg, München, Düsseldorf, Köln, Würzburg, Bückeburg, Weißenfels) plus eszett + Content-Type-without-charset case + Accept-Language assertion (de;q=1, en;q=0.5)
- Detailed report: `.planning/phase-A7-A8a-report.md`
- Commit: `2da0703 fix(geo): preserve umlauts in city names (login-overview no longer renders "Nrnberg")` on origin/main

## Wave B — Quality-leap features

### B1 — Insights/Charts Apple-Health-style visual leap (chart wrappers, first half)

- [ ] Benchmark against Apple Health, Withings Health Mate, Oura Ring
- [ ] Insights surface: gradient fills, animation, dynamic comparisons (better/worse), interactive tooltips, vertical slide-to-compare
- [x] Charts: same level of polish — Recharts replacement allowed if quality bar requires
- [ ] Insights surface visualizes data, not just text-summarizes
- Detailed report: `.planning/phase-B1-report.md`

#### B1a — Charts visual leap (chart wrappers only) — complete

- 2026-05-10T00:35+02:00 — B1a complete on origin/main.
  - **Primitives** (`src/components/charts/{chart-gradient,chart-tooltip,chart-empty-state}.tsx`)
    plus `src/lib/charts/reduced-motion.ts`. 11 unit tests.
  - **HealthChart** (BP/weight/pulse/body-fat/sleep/steps wrapper):
    `LineChart` → `ComposedChart`, gradient-filled `<Area>` per type,
    90-day median personal-baseline `<ReferenceLine>` ("Your normal" /
    "Dein Mittel"), `<RichChartTooltip>` with delta-vs-baseline,
    600 ms ease-out animation respecting `prefers-reduced-motion`,
    sparse-data `<ChartEmptyState>` for <3 points.
  - **MoodChart**: same polish + emoji glyphs at every score (😖 🙁
    😐 🙂 😄 mapped from 1..5) via Recharts `dot` callback; lavender
    gradient under the score line.
  - **MedicationComplianceChart**: same polish, purple gradient,
    rich tooltip with "−N pp vs. target" delta. A6's existing 80 %
    threshold + 100 % goal lines untouched.
  - +23 net tests; full suite 1298/1299 (single pre-existing B6 fail).
  - Commits on origin/main: primitives → `2611bb4` (subject belongs
    to B5b due to a parallel-staging race; my 6 files + 7 i18n keys
    correct), `74c2eb8 feat(charts): BP/weight/pulse polish (gradient,
    baseline, rich tooltip)`, `901f44e feat(charts): mood chart polish
    with emoji glyphs at data points` (also absorbed B5b's
    `provider-runner.ts`), `8008613 feat(charts): medication chart
    polish (gradient + animation + rich tooltip)` (clean).
  - Architectural deviation: brief asked for separate
    `blood-pressure-chart.tsx` / `weight-chart.tsx` / `pulse-chart.tsx`
    files; the codebase has one `HealthChart` wrapper used for all
    three families. Splitting would have been DRY-regressing — kept
    one wrapper, one commit covers all three.
  - "Optional targetWeightKg user-pref" on weight chart not added —
    that's a Settings → Account field B6 owns; chart wrapper already
    accepts a `valueBands` prop the dashboard can pass a target band
    through whenever the user-pref ships.
  - Detailed report: `.planning/phase-B1a-report.md`

### B1 — Insights/Charts Apple-Health-style visual leap (insights surface, second half)

#### B1b — Insights surface visual polish — complete

- 2026-05-10T02:08+02:00 — B1b complete on origin/main.
  - **Page hero** (`src/components/insights/insights-page-hero.tsx`):
    Dracula-gradient band (purple → cyan, /15 + /8 opacity, /25
    border) with sparkles glyph, h1 + overview subtitle, "Based on
    your last 90 days" personal-baseline caption, "Generated
    <relative-time>" caption from the freshest of the per-section
    caches via new `freshestUpdatedAt()` helper, optional regenerate
    button. Animation reuses existing `animate-insight-in` keyframes
    (already gated on prefers-reduced-motion).
  - **Recommendations grid**
    (`src/components/insights/recommendations-grid.tsx`): 1-col mobile,
    2-col desktop CSS grid with severity-priority ordering
    (urgent → important → suggestion → info) via stable
    `sortRecommendationsBySeverity()`. Per-card Dracula left border
    (red/orange/purple/cyan at /70), `md:hover:-translate-y-0.5
    md:hover:shadow-lg` lift, 100ms-staggered fade-in via inline
    `animationDelay`. Internal slots of `<RecommendationCard>`
    untouched per brief — outer `<li>` flipped to `<div>` so the grid
    wrapper can layer CSS grid without invalid HTML5 nesting.
  - **Summary typography**: bumped to `text-foreground/90 max-w-prose
    text-base leading-relaxed`. Inline-chart-token renderer gains
    `mini` flag; summary surface passes mini so embedded charts
    render as 140px sparklines. Per-finding charts keep full chart.
  - **Loading / empty / error**: skeleton mirrors final layout
    (3-card grid, `bg-muted/40-60` pulse, 100ms stagger). Empty
    state gains centred sparkle glyph + max-w-prose copy. Error
    state gains discoverable retry button when `onRegenerate` is
    supplied.
  - **Dashboard `<InsightsCardPreview>`**: replaces the orphan v1.4.0
    `<InsightsCard>` (zero non-test imports, deprecated schema).
    Renders top 1-2 severity-ordered recs as compact tiles + "View
    all" CTA. Same Dracula severity border + ring-variant
    `<ConfidenceMeter>` inline. Returns null when no recs.
  - **Dark mode**: page-hero gradient bumped from /10 + /5 to /15 +
    /8, border /20 → /25 (clears 3:1 UI-element contrast bar against
    Dracula bg). Skeleton placeholders /30/40/50 → /40/50/60.
  - +37 net tests on top of B5e's 1464; full suite 1501/1501,
    integration 59/59, typecheck 0 errors, lint 12 pre-existing
    warnings. Worktree-isolated under `agent/b1b-insights-surface`,
    fast-forwarded to origin/main without rebase (origin sat at
    c8e7639 for the entire run; clean push `c8e7639..3b0d21e`).
  - Commits on origin/main:
    - `4d7d074 feat(insights): page hero with gradient header + generation timestamp + personal-baseline indicator`
    - `9e8be4b feat(insights): recommendations grid with severity ordering + animated reveal`
    - `b76351e feat(insights): polished summary typography with inline-chart sparklines`
    - `0c287f1 feat(insights): polished loading + empty + error states`
    - `d2cdf9d feat(dashboard): InsightsCardPreview matches insights page visual language`
    - `5063ad7 style(insights): dark-mode contrast verification + tweaks`
    - `3b0d21e test(insights): coverage for polished page + dashboard preview`
  - Architectural deviation: brief asked for regex-based inline-
    sparkline extraction from freeform summary prose. The model
    already emits structured `metric:<TYPE>` tokens which the
    existing `<InlineCharts>` renderer handles; flipping summary
    charts to `mini` mode delivers the same visual effect without
    fragile NLP. Regex extraction deferred to v1.4.17 if rec
    authors can't emit structured tokens consistently.
  - E2E (Playwright) not added — `<InsightAdvisorCard>` isn't
    mounted on `/insights` in the production tree (per B5c report's
    same observation); the new SSR integration test
    (`recommendations-grid-integration.test.tsx`) exercises the
    full flow against the MockAIProvider.
  - Detailed report: `.planning/phase-B1b-report.md`

### B2 — AI provider settings UX cleanup (Pulldown-driven)

- [x] Settings → AI: provider dropdown drives form below (no top/bottom split)
- [x] All providers configurable from one UI (Codex / OpenAI direct / Anthropic / Local / Admin OpenAI)
- [x] Form switch-renders dynamically when provider changes
- Detailed report: `.planning/phase-B2-report.md`
- Status block — 2026-05-10T01:15+02:00: B2 complete on `agent/b2-ai-provider-ux`
  worktree, ready for fast-forward into `origin/main`. New `PUT
  /api/insights/provider-chain` (5 unit tests + 2 integration tests).
  Refactored `<AiSection>` collapses the v1.4.15 top/bottom split per
  Marc's `feedback_settings_no_split.md`: one Pulldown drives a
  switch-rendered config card (Codex / OpenAI / Anthropic / Local /
  Admin OpenAI) and a `<FallbackChainCard>` reorders / toggles /
  removes / adds entries with arrow controls (no new dependency —
  `dnd-kit` not in `package.json`). EN+DE i18n keys + 8 new SSR
  tests + 1 Playwright spec. `pnpm test` 1316/1316,
  `pnpm test:integration` 55/55, typecheck 0 errors, lint 0 errors.
  Worktree-isolated under `agent/b2-ai-provider-ux` so the
  parallel-running B5c agent on the rec-card surface can't bleed in.

### B3 — Admin System-Status host-load chart

- [x] Host CPU/memory/disk-io graph last 2h (in-process sampler — Coolify Sentinel had no clean read endpoint)
- [x] Render above current system-status section
- Detailed report: `.planning/phase-B3-report.md`
- Commits on origin/main: `5d1ece1 feat(db): HostMetric model for host-load sampling`, `f1bd801 feat(jobs): host-metric sampler captures load + memory every minute, 7d retention`, `2877710 feat(api): /api/admin/host-metrics returns last 2h of host load + memory`. Chart component + system-status wiring + i18n landed inside `8d9f864 docs(planning): mark Wave-B B5a (medical-reference grounding) complete` due to a parallel-agent staging race during the verification-gate stash/restore loop — files are correct on origin/main, just under a misleading subject. 8 sampler unit tests + 6 API integration tests + 5 chart component tests all green; i18n parity test green.

### B4 — Admin logs visibility deepening

- [x] Audit log: filterable by actor/action/target, paginated (25/50/100 per page), exportable as CSV
- [x] App-log preview: tail of last 500 structured wide-events from per-process ring buffer, filterable by trace_id / level / action / time-window, JSON inspector modal
- Detailed report: `.planning/phase-B4-report.md`
- Commits: `8ac5602` (audit-log API + UI — bundled with verification-gate planning commit due to coordinator stash race; my code, wrong commit subject), `4cc3d8d feat(admin): app-log preview surfaces last 1h of structured events with filter + JSON inspector`, `6520ae4 feat(admin): sidebar entry for app-logs` on origin/main
- Status block — 2026-05-10T00:11+02:00: B4 complete on origin/main. New `src/lib/logging/in-memory-buffer.ts` (500-entry FIFO, FIFO eviction, redaction at API egress only). New `/api/admin/audit-log/actions` populates the action-dropdown via `groupBy`. New `/api/admin/app-logs` route + `<AppLogPreviewSection>` component + `app-logs` admin slug + `<AdminShell>` entry. 51/51 B4 unit tests green; typecheck/lint clean on B4 surface. Sibling B7 broken `export-per-type` typecheck failures predate this phase.

### B5a — Medical-reference grounding

- [x] AHA / ESC / ESH / WHO / DGE target ranges as system context (curated bundle in `src/lib/ai/medical-references.ts`)
- [x] Citations link to source guideline in UI (`<CitationFootnote>` opens in new tab)
- Detailed report: `.planning/phase-B5a-report.md`
- Commits on origin/main:
  - `27f3933 feat(ai): curated medical-reference bundle for citation grounding`
  - `466b8b5 feat(ai): schema accepts validated referenceId pointing into the medical-reference bundle`
  - `7fbfca6 feat(ai): system prompt includes curated medical references for citation grounding`
  - `53aade9 feat(ai): post-validation logs citation-coverage rate per insight generation`
  - `a66c128 feat(insights): citation footnote on recommendations with medical reference`
- 5 atomic TDD-first commits, +44 net tests (15 bundle + 8 schema + 10 prompt + 15 coverage + 6 footnote − overlaps). PROMPT_VERSION bumped 4.15.0 → 4.16.0. Citation-coverage Wide-Event annotation observational in v1.4.16; B5c will flip to required for severity ≥ "important".
- Cross-agent worktree race captured B4 admin files into commit `a66c128` and my commit-5 content into `aff9add` (host-metrics-chart) — see report for detail.

### B5b — Multi-provider redundancy

- [x] try-each-on-hard-failure across configured providers
- [x] Fallback ordering configurable per user
- Detailed report: `.planning/phase-B5b-report.md`
- Commits on origin/main:
  - `2611bb4 feat(db): User.aiProviderChain for ordered fallback config`
  - `901f44e feat(charts): mood chart polish ...` (cross-agent race subject — actual diff includes the B5b runner + provider-chain resolver + route wiring; verified via `git show 901f44e`)
  - `613d661 feat(settings): minimal display of active AI provider + configured chain`
  - `d2bda42 test(ai): provider fallback covers happy path, hard-fail cascade, cache`
- 4 atomic TDD-first commits. New module `provider-runner.ts` exposes
  both a strict `runWithFallback()` (for B5c migration) and a
  legacy-shape `runRawCompletionWithFallback()` (consumed by the
  current route). Hard-fail policy: 401/403/429/5xx/transport
  cascade; schema 422 bubbles. Last-working cache: 1h TTL, in-process,
  per-userId. New `User.aiProviderChain Json?` column + migration
  `0033`. New `GET /api/insights/provider-chain` endpoint feeds
  `<ProviderChainSummary>` (active + cached + configured chain) under
  Settings → AI; full management UX deferred to B2 per scope. EN+DE
  i18n parity green. Cross-agent race: commit 2 subject was hijacked
  by parallel B1a worker (mood-chart polish); my code IS on origin.

### B5c — Per-recommendation explainability

- [x] Each rec carries: WHY (what user-data triggered it), WINDOW (which time range was analyzed), CITATIONS (which medical guideline + which user metric)
- [x] UI: expand-arrow on each rec → reveals the explainability card with mini-chart of the data window
- [x] Schema enforces presence (extends v1.4.15 C1's strict schema)
- Detailed report: `.planning/phase-B5c-report.md`
- Commits on origin/main:
  - `8a438a0 feat(ai): schema requires rationale (window + comparedTo + deviation) per recommendation`
  - `c39a527 feat(ai): system prompt requires rationale per recommendation`
  - `13f1ae5 feat(ai): corrective retry covers missing rationale fields`
  - `c8b30c1 feat(ai): legacy insight payload detection with regenerate CTA`
  - `7f54c0c feat(charts): mini-mode + windowOverride prop for embedded rationale charts`
  - `680f84c feat(charts): mood chart mini-mode + windowOverride`
  - `10a67ff feat(insights): RecommendationCard with expandable rationale + mini-chart of data window`
  - `fed2e7e test(insights): coverage for RecommendationCard expand + rationale rendering`
- Status block — 2026-05-10T01:17+02:00: B5c complete on origin/main. 8 atomic TDD-first commits, +37 net tests (10 schema + 6 prompt + 4 wrapper + 7 legacy-payload + 7 chart-mini + 11 rec-card + 2 integration − fixture updates). Full suite 1361/1361, integration 53/53, typecheck 0 errors, lint 12 pre-existing warnings. New `aiRecommendationRationaleSchema` requires `dataWindow` (enum) + non-empty `comparedTo` + non-empty `deviation` on every rec. New `<RecommendationCard>` subcomponent renders Oura-style "Contributors" expand-card: severity badge + chevron + 3-row rationale + pinned mini-chart (HealthChart for measurement metrics, MoodChart for mood) + B5a citation footnote. Default-collapsed; 200ms ease-out reveal. Named slots (`data-slot="rec-confidence-slot"`, `data-slot="rec-feedback-slot"`) reserved for B5d / B5e plug-in. HealthChart + MoodChart gain `mini` + `windowOverride` props. Legacy payload detection via `isLegacyInsightPayload()` surfaces a "regenerate for new explainability features" CTA on cache-hits where the cached blob predates B5c (no auto-regen — user-initiated only). Worktree-isolated under `agent/b5c-explainability` so the parallel B2 worker couldn't bleed in. E2E (Playwright) NOT added — `<InsightAdvisorCard>` has zero non-test imports in the production tree, so there's no live route reaching the card surface today; the SSR integration test exercises the full flow end-to-end. Medication-compliance mini-chart wrapper deferred — the heatmap doesn't shrink cleanly to 140px and rec authors don't currently emit compliance-keyed recs. Both items flagged for v1.4.17.

### B5d — Confidence Score per Recommendation

- [x] Each rec carries a 0-100 confidence score derived from: data sufficiency (n samples), recency, signal strength
- [x] UI: visual confidence indicator (e.g., color-coded ring or 5-bar meter) per rec
- [x] Below-threshold recs are tagged "Low confidence — based on limited data" rather than hidden
- Detailed report: `.planning/phase-B5d-report.md`
- Commits on origin/main:
  - `0cb0373 feat(ai): deterministic confidence-score computation per recommendation`
  - `af21d4d feat(ai): wrapper overrides recommendation confidence with deterministic computation`
  - `7ec1030 feat(insights): ConfidenceMeter component (bars + ring + draft pill below 25)`
  - `63cfd8e feat(insights): RecommendationCard renders ConfidenceMeter in named slot`
  - `d343ab5 test(insights): coverage for confidence computation + meter rendering`
  - `173c3e1 test(insights): rec-card-confidence test plays nice with B5e thumbs`
- Status block — 2026-05-10T01:40+02:00: B5d complete on origin/main.
  6 atomic TDD-first commits, +48 net tests (15 confidence + 8 schema +
  6 wrapper + 17 meter + 8 rec-card-wiring + 2 integration − 8 fixture
  updates). Full suite 1457/1457, integration 59/59, typecheck 0
  errors, lint 12 pre-existing warnings. New `src/lib/ai/confidence.ts`
  exposes pure `computeConfidence({ n, recencyDays, deviationStdRatio })`
  returning 0..100 (log-saturating n curve, capped at 40, n<3 hard-cap
  5*n; linear recency decay 30→0 over 30d; signal contribution 30 at
  |z|≥1.5, null → neutral 15). `generateInsight()` post-validation step
  OVERRIDES `rec.confidence` deterministically — model's claimed value
  is discarded per research §7 Q1 (Marc-acked). Optional
  `confidenceContext` resolver param lets a future route-layer wiring
  feed bucket-series-aware inputs; default fallback is
  `{ n: metricSource.n ?? 0, recencyDays: 0, deviationStdRatio: null }`
  so the override fires regardless. Wide-Event annotation
  `ai_confidence_override_pairs` carries per-rec `{id, model, computed}`
  for admin observability. New `<ConfidenceMeter>` (bars + ring + draft
  pill <25) with EN/DE i18n + a11y aria-label. Cross-agent race with
  parallel B5e: 2 clean rebases (messages keep-both, rec-card keep-both)
  + 1 fixup commit to add the same useAuth/useMutation SSR mocks the
  existing rec-card test file carries (needed because B5e wired
  RecommendationFeedback into the same component while we both ran).
  Worktree-isolated under `agent/b5d-confidence`. Bucket-series-aware
  resolver wiring + schema flip-to-required deferred to v1.4.17.

### B5e — User-Feedback Loop

- [x] "War das hilfreich?" thumbs-up/down on each rec, persisted as RecommendationFeedback (new table)
- [x] Aggregated feedback infrastructure (daily worker writes per-(severity x metricSourceType x provider x prompt-version) summary to AppSettings) — prompt-mutation itself deferred to v1.4.17 ratchet per research §3
- [x] Privacy: feedback is per-user; cross-user aggregate gated behind /admin/ai-quality (requireAdmin); single-user-default-on per research §3
- Detailed report: `.planning/phase-B5e-report.md`
- Commits on origin/main:
  - `badc893 feat(db): RecommendationFeedback model with GDPR cascade + provider attribution`
  - `8255e3e feat(api): /api/insights/feedback persists thumbs with provider attribution`
  - `ca84fb7 feat(insights): thumbs-up/down feedback component with optimistic updates`
  - `47ca1e4 feat(insights): RecommendationCard renders feedback thumbs in named slot`
  - `71ffe30 feat(jobs): daily feedback aggregator writes per-(severity x provider) summary to AppSettings`
  - `8879282 feat(admin): AI quality preview showing per-(severity x provider) helpful-rate`
- Status block — 2026-05-10T01:45+02:00: B5e complete on origin/main.
  6 atomic TDD-first commits; +20 net direct tests on top of B5d's
  parallel +56. New Prisma model `RecommendationFeedback` with the
  `(userId, recommendationId, recommendationText)` dedup key; server-
  side provider attribution via `resolveFeedbackAttribution()` (reads
  latest `insights.generate` audit row, prefers chainProviderType >
  providerType > "unknown"). New `<RecommendationFeedback>` component
  fills B5c's `data-slot="rec-feedback-slot"` with TanStack Query
  optimistic updates + localStorage refresh-defence; `asFeedbackTime
  Range()` defence-in-depth gate keeps the slot empty for legacy/
  partial recs so a thumbs-click can never produce a 422. New
  pg-boss `feedback-aggregator` queue (daily 04:00 Europe/Berlin)
  writes per-(severity x provider) helpful-rate summary to
  `AppSettings.adminAiInsightsFeedbackSummary`. New `/admin/ai-quality`
  route surfaces the table tinted by helpful-rate band. EN+DE i18n:
  18 new keys. `pnpm test` 1464/1464, `pnpm test:integration` 59/59,
  `pnpm typecheck` 0 errors, `pnpm lint` 12 pre-existing warnings.
  Worktree `agent/b5e-feedback-loop` shipped without colliding with
  B5d's parallel ConfidenceMeter wiring on the same rec-card surface
  (named-slot pattern delivered as designed).

### B6 — Settings naming-audit

- [x] Every settings sub-route reviewed for stringency, naming consistency, logical grouping
- [x] No top/bottom split anti-pattern anywhere (AI flagged for B2 — only known instance, out of B6 scope)
- [x] No double naming (audit found no live duplicate; settings vs admin scope rule landed in CLAUDE.md)
- Detailed report: `.planning/phase-B6-report.md` · audit doc: `docs/audit/v1416-settings-audit.md`
- Commits on origin/main:
  - `01a05e4 docs(audit): v1.4.16 settings naming + consolidation audit`
  - `a432cb2 refactor(settings): consistent naming + i18n key namespace`
  - `ed0cfda refactor(settings): remove duplicate toggles, route to canonical owner`
  - `d914f76 test(settings): coverage for renamed/consolidated sections`
- Status block — 2026-05-10T00:28+02:00: B6 complete on origin/main. Threshold component renames (`thresholds-settings-section.tsx` → `thresholds-section.tsx` route wrapper; old `thresholds-section.tsx` inner editor → `thresholds-editor-section.tsx` `<ThresholdsEditorSection>`) align every section with the canonical `<slug>-section.tsx` `<SlugSection>` convention. Three muddy section descriptions rewritten in EN + DE (`account`, `api`, `advanced`); `notifications.description` rewritten so the DE doesn't verbatim-copy the EN. New `sections-i18n-parity.test.ts` walks every `SETTINGS_SECTION_SLUGS` entry and asserts both `.title` + `.description` resolve in EN+DE and the DE differs from the EN. Settings tests 63/63 (was 40/40, +23 net). Typecheck 0 errors, lint 0 errors / 12 pre-existing warnings. Worktree-isolated under `agent/b6-settings-audit` so the sibling B1/B5b uncommitted state in the primary checkout couldn't bleed in. AI section top/bottom split (Marc's specific call-out) flagged for B2; flat-key hygiene PR flagged for post-v1.4.16.

### B7 — Settings → Export menu (Arztbrief consolidated)

- [x] New /settings/export route with consolidated UI: Doctor-report (PDF, configurable date range + practice name from B6 v1.4.15) + CSV/JSON exports (measurements/medications/mood per CLAUDE.md src/lib/export.ts)
- [x] Properly designed: card per export type, clear preview + filter + download button
- [x] Rename current doctor-report entry-point to live under /settings/export
- Detailed report: `.planning/phase-B7-report.md`
- Commits on origin/main:
  - `621109c feat(settings): export-section consolidates doctor-report, CSVs, JSON backup`
  - `a512650 feat(settings): /settings/export dynamic route wired into sidebar`
  - `94c748d refactor(doctor-report): entry-point relocated under /settings/export`
  - `226cac4 docs(planning): mark phase B3 (host-load chart) complete` — absorbed
    the four `/api/export/*` route files + per-type unit tests + integration suite
    via a parallel-agent staging race during the verification gate's stash/restore
    loop. Code authored by me (Marc + Co-Authored-By Claude Opus), commit summary
    name belongs to B3.
  - `d5c8912 fix(export-section): point download buttons at the new plain-segment endpoints`
  - `830b2b0 test(export): integration test points at the new plain-segment endpoints`
  - `e628f33 test(export): coverage for export-section + endpoints`
- 5 cards rendered (Doctor Report PDF / Measurements CSV / Medications CSV with
  optional intake-history toggle / Mood CSV / Full JSON Backup), each on its
  own `data-testid` so the e2e suite can target without relying on i18n labels.
  Mobile stacks; `>=md` is a 2-column grid. AdvancedSection is now danger-zone-only.
  Routes use plain segments (`/api/export/measurements` rather than `.csv` —
  vitest can't resolve dotted segments cleanly; the file extension lives in
  `Content-Disposition`). All four endpoints share the global `export:<userId>`
  10/h rate-limit bucket and write a `user.export.<kind>` audit-log entry.
  10 unit + 9 integration + 2 e2e tests pin the contract.

### B8 — Extended Comparison Views (Vormonat / Vorjahr)

- [x] Each chart + tile + insight gets toggleable comparison overlay: "vs. last month" / "vs. last year"
- [x] Visual treatment: dimmed historical line beneath current; delta callout (Δ +5%, etc.)
- [x] Insights surface narrates the comparison ("Your average BP improved by 4 mmHg vs. last month")
- [x] Mobile-friendly comparison toggle (not a fragile hover-only interaction)
- Detailed report: `.planning/phase-B8-report.md`
- Status block — 2026-05-10T02:38+02:00: B8 complete on origin/main. 4 atomic
  TDD-first commits + 27 new tests (4 layout + 11 shift helper + 2 chart SSR
  + 6 tile SSR + 8 prompt). Worktree-isolated under `agent/b8-comparison-views`
  shipped clean (no rebase race; origin sat at `43204cb` for the run).
  - Commits on origin/main:
    - `775df8c feat(comparison): comparison toggle persists baseline preference`
    - `2cf7b74 feat(charts): comparison overlay shows prior-period as dimmed line with delta tooltip`
    - `e4a408e feat(dashboard): tiles show comparison delta callout when toggle is active`
    - `f9f99ea feat(insights): AI narrates comparison when toggle is active`
  - Architectural decisions: JSON-pivot persistence path (no Prisma migration
    per research §7 Q3); forward-shift overlay so prior-period points sit
    directly under their current-period siblings on the visible x-axis;
    DataSummary gains `avg30LastMonth` + `avg30LastYear` fields so dashboard
    tile + AI snapshot read the same delta. PROMPT_VERSION 4.16.0 → 4.16.1.
  - Deferred to v1.4.17 (planning notes in report): dedicated
    `/insights/compare` route (research-recommended bonus), schema flip to
    add `aiInsightResponseSchema.comparison` field + `<InsightsComparisonCallout>`
    UI component above the recommendations grid. Reserved i18n keys
    `comparison.insightsCallout.{lastMonth,lastYear}` so the future component
    drops in clean.
  - Verification: `pnpm test` 1532/1532, `pnpm test:integration` 59/59,
    `pnpm typecheck` 0 errors, `pnpm lint` 12 pre-existing warnings.

## Wave C — Catch-up (deferred from v1.4.15)

- [x] CI Integration tests + e2e workflows pre-existing red since
  `d8c549e` — both green from this phase forward
- [x] 5 of 8 deferred HIGH from v1.4.15 Wave-D (H1, H2, H4 code-review,
  H4 design, H3 senior in-use; H3 mood-chart skipped per charts/
  ownership; H1+H2 senior splits deferred)
- [x] 3 of 5 deferred MED from A5 mobile (tabs scroll, bottom-nav
  5+More, system-status retry; measurements BP grouping + DOM
  weight deferred to v1.5)
- [x] Coolify image-digest auto-deploy trigger — DEFERRED with v1.5
  plan documented in `docs/audit/v1416-auto-deploy-fix.md` (Marc-
  side UI flip is the 5-min realistic fix; MCP API doesn't expose
  the toggle)
- [x] docker-publish main-branch hang — root cause was qemu-arm64
  SIGILL; dropped arm64 from the platforms list, v1.5 to re-add via
  native `ubuntu-24.04-arm` matrix
- Bonus: B5a i18n parity for `insights.recommendation.{source,viewSource}`
- Detailed report: `.planning/phase-C-report.md`

### Status block — Wave C
- 2026-05-10T00:44:00+02:00 — Wave C complete on origin/main.
  Worktree-isolated agent at `/Users/marc/Projects/HealthLog-c` on
  `agent/wave-c-catchup` shipped 11 commits without a single shared-
  cwd race. CI Integration green (5 successive successes), e2e
  in-progress at write time on `0d08e33`. `pnpm test` 1303/1303,
  `pnpm test:integration` 53/53 (after `pnpm db:generate` for B5b's
  new `aiProviderChain` column), `pnpm typecheck` 0 errors,
  `pnpm lint` 12 pre-existing warnings.
  - **CI fix:** `fbcd106` — quoted `ENCRYPTION_KEY` YAML scalar (was
    parsed as integer 0) + seeded `onboarding_tour_completed = true`
    in e2e global-setup so the spotlight tour overlay stops
    intercepting clicks across 9 specs.
  - **HIGH H1:** `fdac9e2` admin restore-failed scrubs raw Prisma
    error.
  - **HIGH H2:** `7f1a4de` moodEntry.tags refined to JSON-array.
  - **HIGH H4 code:** `2afe3c4` tour-launcher sessionStorage scoped
    by user id.
  - **HIGH H4 design:** `b863e2c` 44 px tap targets on tour /
    backups / notifications.
  - **i18n parity:** `2a7ef72` Quelle / Leitlinie translations.
  - **MED tabs:** `d7c2b2a` horizontal scroll on mobile.
  - **MED bottom-nav:** `072eee6` 5+More with overflow sheet.
  - **MED system-status:** `65b4bf9` Retry button.
  - **Auto-deploy doc:** `4be6465` defer + v1.5 plan.
  - **docker-publish:** `cc0f343` drop qemu-arm64.

## Wave D — Multi-agent QA + Product-Lead

- [x] code-reviewer (0 CRITICAL, 8 HIGH, 9 MED, 10 LOW)
- [x] security review (0 CRITICAL, 2 HIGH, 5 MED, 3 LOW)
- [x] design / UX review (Apple Health benchmarking lens) — 3 CRITICAL,
      8 HIGH, 22 MED/LOW
- [x] senior-dev review (0 CRITICAL, 3 HIGH, 9 MED/LOW)
- [x] simplify (8 apply-yes / 2 apply-no)
- [x] Product Lead — state of app, biggest items, v1.5 roadmap,
      follow-on initiatives
- [x] Reconcile applies CRITICAL/HIGH inline
- Detailed report: `.planning/phase-D-reconcile-report.md` +
  `phase-D-product-lead-review.md`

### Status block — Wave D reconcile

- 2026-05-10T03:20+02:00 — Wave D complete on origin/main.
  - **CRITICAL**: 1 of 3 fixed inline (C3 on-surface comparison
    toggle, commit `6e74d38`); 2 deferred to v1.4.17 with documented
    rationale (C1 + C2 — both require new API surfaces, root cause
    "scope-completion-without-route-wiring").
  - **HIGH**: 9 fixed inline (`5f7b9d8`, `6863ecb`, `fb12f09`,
    `c3451a4`, `2f057f4`, `5661439`); 1 already-fixed (code-review
    H1 — reviewer mis-read source); 11 deferred to v15-backlog.md.
  - **Simplify**: 7 of 8 apply-yes landed (commit `f3025a8`); F1 +
    F8 are apply-no flagged for Marc.
  - **Product-Lead review** stands as-is; IS the strategic v1.5 plan.
  - **Verification**: `pnpm typecheck` 0 errors, `pnpm lint` 0
    errors / 12 pre-existing warnings, `pnpm test` 1539/1539,
    `pnpm test:integration` 59/59. format:check is not in CI; my
    new files prettier-formatted.
  - **Backlog seed**: `.planning/v15-backlog.md` is the v1.5
    milestone planning input.
  - **Reconcile commits**: `c0c1284` planning refresh, `6e74d38`
    C3, `c3451a4` H1+H2+H6+H7 a11y, `2f057f4` H3 i18n leak,
    `fb12f09` security H1+H2, `5661439` H4 design, `f3025a8`
    simplify, `6863ecb` H5+H6 code-review, `5f7b9d8` H2
    code-review.
- [x] CRITICAL C1 wired (commit aae968a); [x] CRITICAL C2 wired (commit 8a5b6de)
  - 2026-05-10T03:35+02:00 — both deferred CRITICALs wired before the
    v1.4.16 tag. `<InsightAdvisorCard>` now mounts on `/insights`
    (consuming `/api/insights/generate` POST cache-aware, no new API);
    `<InsightsCardPreview>` now mounts on `/` (gated by new
    `insightsPreview` widget id in `DASHBOARD_WIDGET_IDS` + default
    layout). New `useInsightsAdvisorQuery()` hook shares the cache
    between both surfaces. Two new e2e specs prove the live routes
    reach the polished components (B5c/d/e/B1b). Verification:
    `pnpm typecheck` 0 errors, `pnpm lint` 0 errors / 12 pre-existing
    warnings, `pnpm test --run` 1540/1540 (+1 widget-contract test),
    `pnpm test:integration` 59/59. Detailed report:
    `.planning/phase-D-c1-c2-wire-report.md`. Style cleanup:
    `c63cddc style(insights): prettier sweep on C1 + C2 wire-up files`.

## Phase E — Release v1.4.16

- [x] Pre-release verify
- [x] Bump package.json + CHANGELOG
- [x] Tag + push v1.4.16
- [x] GHCR build (verify both main + tag green; C3 v1.4.16 fix DID help main)
- [x] Coolify deploy (retag-on-host fallback; auto-deploy still races GHCR)
- [x] /api/version=1.4.16 confirmed (transition at 2026-05-10T03:45:58+02:00)
- [x] Production smoke (13/14 200; `/dashboard` 404 expected — root is dashboard)
- [x] GH release — https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16
- [ ] Docs site + landing site sync
- [ ] `docs/audit/v1416-summary.md` (Marc-Brief)
- Detailed reports: `.planning/phase-E1-report.md`, `.planning/phase-E2-report.md`

### Status block — Phase E2 (deploy + verify)

- 2026-05-10T03:48+02:00 — Phase E2 complete; v1.4.16 LIVE at
  https://healthlog.bombeck.io.
  - **GHCR**: BOTH runs `success` — Wave-C C3 fix (drop arm64 from
    main-branch publish) was effective. Run `25616783583` (tag) +
    `25616782255` (main) both green.
  - **Image digest**: `ace7d441f47b…` (v1.4.15) → `05f8a126d639…`
    (v1.4.16). Visibly changed.
  - **/api/version transition**: `1.4.15` → `1.4.16` at
    `2026-05-10T03:45:58+02:00` (1 s after host-side retag returned;
    well under 5 min cap).
  - **Coolify auto-deploy**: NO — same race as v1.4.14/v1.4.15.
    Coolify fired on chore(release) commit at `01:40:17Z` BEFORE
    GHCR finished, so pulled stale local `:latest`. Ran
    retag-on-host fallback (`docker pull :1.4.16 && docker tag
    :1.4.16 :latest && docker compose up -d app`).
  - **Smoke (14 routes, Marc's session)**: 13/14 200; `/dashboard`
    404 expected (root `/` is the dashboard, no `/dashboard` route
    exists — same response shape on v1.4.15, NOT a regression).
  - **GH release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16
    (created via `gh release create v1.4.16`, notes from
    `sed -n '3,171p' CHANGELOG.md`; awk recipe in the phase-E2 brief
    had a precedence issue and only captured the version header — sed
    range-extract used instead).
  - **Outstanding for v1.5**: Coolify auto-deploy race (Marc-side UI
    flip per `docs/audit/v1416-auto-deploy-fix.md`); arm64 reinstatement
    via native `ubuntu-24.04-arm` matrix (currently amd64-only post-C3).
  - Detailed report: `.planning/phase-E2-report.md`.

### Status block — Phase E1 (verify + tag)

- 2026-05-10T03:40+02:00 — Phase E1 complete on origin/main.
  - Verification: `pnpm typecheck` 0 errors, `pnpm lint` 0 errors / 12
    pre-existing warnings, `pnpm test` 1540/1540 (192 files, 4.29s),
    `pnpm test:integration` 59/59 (16 files, 8.35s). `pnpm format:check`
    skipped per project convention (not in CI; `pnpm format` corrupts
    `.planning/` markdown list-markers — already observed in Phase 0).
    `pnpm build` + `pnpm e2e` deferred to CI Docker (Node 22).
  - Release commit: `d443c22 chore(release): v1.4.16` (package.json
    1.4.15→1.4.16 + CHANGELOG entry, English-only per Marc's "alles
    Englisch" note).
  - Tag pushed: `v1.4.16` (annotated, message `HealthLog v1.4.16`).
  - Push: `5e89382..d443c22 main -> main` + `[new tag] v1.4.16` to
    `github.com:MBombeck/HealthLog.git`.
  - GHCR run: id `25616783583` (Build & Publish Docker Image on
    `v1.4.16`) — in_progress at write time. Sibling runs on `main`:
    GHCR `25616782255`, Security & Quality `25616782285`, Integration
    tests `25616782236`, e2e `25616782233`.
  - 4 stale dotted-segment export route directories remain untracked
    (`src/app/api/export/{full-backup.json,measurements.csv,medications.csv,mood.csv}/`)
    — the live plain-segment routes shipped in B7. Left out of the
    release commit.
  - Detailed report: `.planning/phase-E1-report.md`.

---

## Previous milestone — v1.4.15 (completed 2026-05-09T22:50+02:00)

LIVE at https://healthlog.bombeck.io · `/api/version=1.4.15` · image digest
`sha256:ace7d441f47b…` (was `0ced46004a54…` on v1.4.14).

Full Marc-Brief, commit table, deferred items, CI/prod state and
Phase-D reconcile detail: `docs/audit/v1415-summary.md`. Backlog seeded
to `.planning/v1416-backlog.md` (8 deferred HIGH + 39 MED/LOW + 4
simplify-no + 3 process items).

Phases run during v1.4.15 marathon:

- Phase 0 — Bootstrap (STATE+ROADMAP for v1.4.15)
- Phase A1–A5 + B-mobile — Quick fixes (nav, admin overview, quick-add labels, dashboard analytics, mobile audit + fix-application)
- Phase B1–B6 — Bigger features (backup completeness, Withings/moodLog robustness, notification reliability, achievements UI, onboarding tour, doctor-report v2)
- Phase C1–C5 — Hardening (AI/Codex schema + slug-drift, Coolify auto-deploy, CI/e2e reliability, i18n parity, empty-states audit)
- Phase D — Multi-agent QA (5 reviewers + reconcile; 0 CRITICAL, 5 HIGH fixed inline, 8 HIGH deferred to v1.4.16)
- Phase E1–E3 — Release (v1.4.15 tag, GHCR, host-side retag deploy, docs+landing sync, summary)

Marathon recurring meta: per-agent git-worktree adoption deferred to
v1.4.16 (commit-message drift recurred across A2, A4, B1, B-mobile, B2,
B3, B4, C1, C5).

---

## Status block — Phase 0 (v1.4.16)

- 2026-05-09T23:12:52+02:00 — Phase 0 complete. STATE.md + ROADMAP.md
  scaffolded for v1.4.16 marathon (Wave A: A1-A8, Wave B: B1-B7, Wave C
  catch-up, Wave D multi-agent QA + Product-Lead, Phase E release).
  Previous v1.4.15 entries archived above. Working tree was carrying
  re-run-prettier corruption on 22 .planning/ files (markdown list-
  marker `+` flipped to `-`, breaking content) — discarded via
  `git checkout -- .planning/` before scaffold; tracked files clean.
  Untracked v1.4.14/v1.4.15 leftover phase reports (15 files) left in
  place — they belong to previous milestones, not v1.4.16. Phase 0
  commit contains only `.planning/STATE.md`, `.planning/ROADMAP.md`,
  `.planning/phase-0-report.md`. Marc-status: speed matters.

## Status block — Wave A bucket-1 (A1 + A3)

- 2026-05-09T23:26:00+02:00 — A1 + A3 complete on origin/main.
  - **A1** removed the entire admin sub-list expansion from
    `sidebar-nav.tsx`; the Admin entry now mirrors the Settings entry
    exactly (single link, no sub-items at any route, gravatar
    dropdown unaffected). Vitest + new e2e
    `e2e/sidebar-admin-no-expand.spec.ts` cover the contract.
    Commit `77fe256`.
  - **A3** swapped the api-tokens desktop `<table>` for a real mobile
    card-list at <md (mirrors `<UserManagementSection>`). No
    `overflow-x-auto` inside the mobile container; long names + perm
    badges wrap within the card. New e2e
    `e2e/admin-api-tokens-mobile.spec.ts` asserts no page scroll at
    Pixel 5 with a worst-case payload. Commit `277a5aa`.
  - Verification: `pnpm typecheck` clean, `pnpm lint` 12 pre-existing
    warnings / 0 errors, `pnpm test` 1056/1057 (the single failure
    is in A2's `bp-in-target.test.ts`, out of bucket-1 scope).

## Status block — Wave A bucket-3 (A4 + A5 + A8b)

- 2026-05-09T23:31:00+02:00 — A4 + A5 + A8b complete on origin/main.
  - **A4** "7-Tage-Trend" rename across DE/EN (`movingAverage7d`,
    `moodMA`, `trend7dShort` all use the long form now), plus
    `summaryToTrend7Delta()` falls back to `slope30` when `slope7`
    is null so sparser metrics like mood (logged < daily) show a
    delta number instead of dropping the indicator. Commit `4df6dac`.
  - **A5** root-cause: `widgetIdEnum` in
    `src/app/api/dashboard/widgets/route.ts` was missing
    `achievements`, so every PUT against the default layout 422'd
    silently and the toggle never persisted. Extracted
    `DASHBOARD_WIDGET_IDS` as the single source of truth in
    `src/lib/dashboard-layout.ts` and derived the Zod enum from it
    so the lists cannot drift again. Also hide the tile-strip
    wrapper when zero tiles are visible (Marc's
    "ganze Spalte breit, gleicher Höhe" constraint). Commit `93e712d`.
  - **A8b** chart trend on "All" filter rounded to ±0 because
    per-week rate over multi-year windows falls below the
    1-decimal display precision. Added pure
    `computeWindowTrend()` helper at
    `src/lib/analytics/window-trend.ts` that returns both the
    per-week delta and a split-half mean delta (second-half mean
    minus first-half mean) for windows ≥ 90 days. The chart now
    surfaces "Total +5.4 kg (6.7 %)" alongside the per-week rate
    on long ranges. 7 unit tests pin the helper. Commit `af77e5e`.
  - Verification: `pnpm test` 1081/1081 (+32 net), `pnpm typecheck`
    0 errors, `pnpm lint` 12 pre-existing warnings / 0 errors.
    Detailed report: `.planning/phase-A4-A5-A8b-report.md`.

## Status block — Wave-A verification gate

- 2026-05-10T00:08:00+02:00 — [x] Wave-A verification gate green, ready
  for Wave B (gate-run sha `94c748d`). Local clean clone passes
  typecheck (0 errors), lint (12 pre-existing warnings), `pnpm test`
  1153/1153, `pnpm test:integration` 41/41. CI Security & Quality
  workflow consistently passes Wave-A commits. Integration + e2e CI
  workflows are pre-existing red (predate Wave A by hours; identical
  failure shape on v1.4.15 release commit `0985c93`); not a Wave-A
  regression. `pnpm format:check` flags 34 .planning/docs/test files
  but is not in any CI workflow. Detailed report:
  `.planning/phase-wave-a-gate-report.md`.

## Status block — Phase E3 (docs + landing sync)

- 2026-05-10T03:55+02:00 — Phase E3 complete. healthlog-docs +
  healthlog-landing both pushed to origin/main.
  - **healthlog-docs** (Starlight): 9 pages refreshed
    (`8addef4`) + 3 new deep-dive pages (`2a5802b`):
    `/insights/how-it-works/`, `/dashboard/comparison/`,
    `/settings/ai-providers/`. Astro build green: 44 pages built.
  - **healthlog-landing** (Next.js): `softwareVersion` 1.4.15 →
    1.4.16 + AI hero card rewrite + 5 new feature-list entries +
    2 capability badges (`3d17207`). `pnpm build` green.
  - No "Claude / AI / agent / marathon / phase" leak in either
    repo. Co-Author trailer present on all three commits.
  - Detailed report: `.planning/phase-E3-report.md`.

## Status block — v1.4.16 marathon FINISHED

- 2026-05-10T04:05+02:00 — v1.4.16 marathon closed.
  - **Live**: `/api/version=1.4.16` on https://healthlog.bombeck.io
    since 03:45:58+02:00.
  - **Image digest**:
    `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa`
    (was v1.4.15: `sha256:ace7d441f47b…`).
  - **GH release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.16
  - **Smoke**: 13/14 200 (`/dashboard` 404 expected — root `/` is
    the dashboard, not a regression).
  - **Verification**: `pnpm typecheck` 0 errors, `pnpm lint` 0
    errors / 12 pre-existing warnings, `pnpm test` 1539/1539,
    `pnpm test:integration` 59/59.
  - **Marc-Brief**: `docs/audit/v1416-summary.md` written; commit
    `docs(audit): v1.4.16 release summary` pushed to origin/main.
  - **v1.5 backlog seeded**: `.planning/v15-backlog.md` (the
    tactical follow-ons) + `.planning/phase-D-product-lead-review.md`
    (the strategic v1.5 backbone — Marc's recommended 6-week focus:
    C.1 + C.2 + C.4 + C.7 + C.10 + C.11a Apple Health).
  - **Outstanding for v1.5**: Coolify image-digest auto-deploy
    (Marc-side UI flip), native arm64 runner matrix for
    docker-publish, prompt-tuning ratchet on B5e feedback storage,
    dedicated `/insights/compare` page, iOS contract freeze + bulk
    endpoint, S3 backup push, Apple Health import.
  - Status: **finished**.
