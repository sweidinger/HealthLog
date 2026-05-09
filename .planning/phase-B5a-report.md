# Phase B5a — Medical-reference grounding (v1.4.16)

Completed 2026-05-10 ~00:04 CEST.

## What landed

Five atomic commits on origin/main, each TDD-first (failing test, then
fix, then verification):

| # | Commit | What it ships |
|---|--------|---------------|
| 1 | `27f3933 feat(ai): curated medical-reference bundle for citation grounding` | `src/lib/ai/medical-references.ts` with 7 guidelines (ESH 2023, ESC 2024, ACC/AHA 2017, WHO 2021 hypertension, WHO BMI, DGE 2024 nutrition, AHA pulse). Each entry: stable slug, EN+DE titles, https URL, year, scope tags, metric buckets. `selectReferencesForMetrics()` filters by overlap; `getMedicalReferenceById()` lookups defensively return undefined. 15 unit tests. |
| 2 | `466b8b5 feat(ai): schema accepts validated referenceId pointing into the medical-reference bundle` | `aiRecommendationSchema.referenceId` (optional) validated via `superRefine` against `MEDICAL_REFERENCE_IDS`. Fabricated ids fail parse — defence in depth on top of the prompt instruction. `PROMPT_VERSION` bumped to `4.16.0`. 8 unit tests. |
| 3 | `7fbfca6 feat(ai): system prompt includes curated medical references for citation grounding` | New `buildSystemPromptWithReferences(locale, metrics)` injects a SOURCES block listing only references whose `metricApplicability` overlaps the current metrics, plus a GROUND RULE telling the model to cite by id. Plain `getStrictInsightsSystemPrompt(locale)` unchanged for back-compat. 10 unit tests. |
| 4 | `53aade9 feat(ai): post-validation logs citation-coverage rate per insight generation` | `src/lib/ai/citation-coverage.ts` — `detectsNormativeClaim()` (EN+DE keyword heuristic) + `computeCitationCoverage()`. The wrapper at `generate-insight.ts` calls `annotate()` with `ai_total_recommendations` / `ai_normative_recommendations` / `ai_cited_normative_recommendations` / `ai_uncited_normative_recommendation_ids` so the admin AI quality dashboard can chart coverage over time. Observational only; B5c flips to required for severity ≥ "important". 15 unit tests. |
| 5 | `a66c128 feat(insights): citation footnote on recommendations with medical reference` | `<CitationFootnote>` subcomponent in `insight-advisor-card.tsx` renders "Source: ESH 2023 — title" with `<ExternalLink>` icon, opens in a new tab via `target="_blank" rel="noreferrer"`. `InsightResult.recommendations` widens to a union (legacy string OR `{ text, referenceId? }`) so existing render paths keep working. New i18n keys `insights.recommendation.source` + `insights.recommendation.viewSource` in EN+DE. 6 component tests. |

## Verification

- 154 AI-surface unit tests pass (was 124 → +30 net for B5a).
- 11 insights-component tests pass (was 5 → +6 net).
- Full suite 1180/1180 BEFORE the commit-5 cross-agent files landed; after, 4 unrelated test files fail due to other agents' WIP (export, host-metrics-chart, admin-sections, in-memory-buffer). None of those are mine.
- `pnpm typecheck` — only pre-existing errors from other agents' WIP (B7 export-section, B3 host-metric-sampler, B4 audit-log/app-logs).
- `pnpm lint` — 13 warnings / 0 errors (1 new warning from B3, 12 pre-existing).
- `pnpm test:integration` 41/41 pass.

## Cross-agent race notes

The shared working tree against the same git index produced two
collisions during the marathon:

1. Commit `aff9add` (B3 host-metrics-chart) initially landed with my
   commit-5 staged content because the index race captured my files.
   Reset --soft + recommit fixed the message, but the diff stat under
   that hash is mine. The host-metrics-chart code lives in `a66c128`
   bundle alongside it.
2. Commit `a66c128` (mine) bundles B4 admin app-logs / audit-log /
   in-memory-buffer files because their untracked files swept into my
   `git add` of named paths. The insight-card / footnote / schema /
   i18n changes in that commit are all mine; the rest is B4's work
   that landed on the same staging.

The cross-agent worktree adoption deferred from v1.4.15 — see
`docs/audit/v1415-summary.md` — would have prevented this. v1.4.17
should ship that or restrict to one agent per shared filesystem.

## Open questions defaulted (per research §7)

- §7.1 confidence shape: N/A here — that is B5d.
- §7.2 feedback policy: N/A here.
- §7.3 comparison persistence: N/A here.
- §7.4 narrative scope: N/A here.
- "Reference URL never opens in an in-app webview" — implemented.
  Always `target="_blank" rel="noreferrer"`.

## What B5b inherits

- Curated `MEDICAL_REFERENCES` bundle is the single source of truth
  for any normative claim. B5b multi-provider fallback can re-use the
  same prompt builder + schema check unchanged — provider abstraction
  doesn't need to know about references.
- The `annotate()` citation-coverage breakdown is per-generation;
  multi-provider cascade should aggregate per `providerType` later
  (the wide-event already carries `providerType` so the dashboard can
  slice).
