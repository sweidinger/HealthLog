# v1.4.16+ AI hardening roadmap

Authored: 2026-05-09 during the v1.4.15 Phase C1 marathon.

Marc, verbatim 2026-05-09:

> "Es darf null Halluzinationen haben und es muss sich halt irgendwie
> stützen auf medizinische Dinge. Ich möchte da eine gewisse Dynamik
> drin haben."
>
> ("Zero hallucinations. Must ground on medical facts. I want some
> dynamism.")

v1.4.15 Phase C1 ships **infrastructure** — the schema, the wrapper,
the citation enforcement, the scope-hardened prompt, the slug-drift
defence. The medical-grounding work, the multi-provider redundancy,
the explainability layer and the feedback loop land in v1.4.16+.

This document is the iteration roadmap Marc explicitly invited.

## What landed in v1.4.15 (recap)

| Deliverable                                        | Commit subject                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AIProvider` interface + `MockAIProvider` + tests  | `refactor(ai): consolidate providers behind AIProvider interface`               |
| Strict response schema + retry-once wrapper        | swept into `docs(audit): v1.4.15 empty-states audit + i18n keys` (sibling race) |
| Citation-from-data invariant (11 tests)            | `feat(ai): enforce citation-from-data on every recommendation`                  |
| Scope-hardened versioned prompt (`PROMPT_VERSION`) | `feat(ai): scope-hardened system prompt with refusal pattern`                   |
| Slug-drift defence (chain + cache)                 | `feat(ai): fallback-chain slug discovery with 1h positive cache`                |
| Spec `docs/codex-protocol-spec.md` §7b             | (rolled into the slug-drift commit)                                             |

NOT done in v1.4.15 (deliberately deferred):

- The `/api/insights/generate` route does NOT yet adopt
  `generateInsight()` — the existing UI consumes the rich legacy
  shape (`{summary, classification, findings, correlations,
  dataQuality, ...}`). Migrating the consumer is v1.4.16 work because
  it requires UI changes to `<InsightAdvisorCard />` and
  `<InsightsCard />` to render the new strict shape.
- The scope-hardened prompt at `src/lib/ai/prompts/insight-generator.ts`
  is exported but not yet wired in. Same reason — the UI needs to
  consume `recommendations[]`-as-objects + `citations[]` + `warnings[]`
  before the prompt can be flipped.

## v1.4.16 — Medical-reference grounding

Goal: the model no longer cites "ESH/ESC 2024 generic guidance" verbatim
from the prompt. Instead it cites a small **embedded** quote from the
guideline document, with a rendered footnote in the UI.

### Subtasks

1. **Curate the reference set.** A versioned bundle in
   `src/lib/ai/references/` containing ~40 short excerpts:
   - ESH/ESC 2024 BP guidelines — adult target, hypertension stages,
     non-pharmacological measures.
   - AHA/ACC 2017 BP guidelines — alternative thresholds (USA-context).
   - WHO 2021 sleep / activity guidance.
   - Saint-Maurice et al. 2020 step-count dose-response.
   - DGE / DEGAM (German GP) lifestyle leaflets — already-translated
     plain language for the German UI.
   - DGE healthy-weight (BMI bands).
   - AASM 2015 sleep duration consensus.
   Each excerpt: `{ id, source, citation, excerpt, locale, validity }`.
   Curated by hand (NOT scraped) — no quote longer than 200 characters
   to stay inside fair-use.

2. **Inject relevant excerpts as system context per request.** A
   pre-flight step `selectRelevantReferences(features)` looks at the
   user's snapshot and selects 3-5 excerpts most relevant (BP elevated
   → ESH/ESC excerpts; weight gain → DGE BMI excerpts). Injected into
   the system prompt as a `## Relevant guidelines` block with each
   excerpt verbatim.

3. **Schema extension.** Each `recommendation[].metricSource` and each
   `citations[]` entry gains an optional `referenceId` field pointing
   into the bundle — the model uses an excerpt's `id` to back its
   citation. The UI then renders a footnote `[1] ESH/ESC 2024,
   p. 17 — "..."` next to the recommendation.

4. **Hallucination guard for references.** Schema rejects any
   `referenceId` not in the bundle. The model cannot fabricate a
   citation pointing at a guideline that doesn't exist.

5. **Locale support.** German excerpts shipped first — Marc's primary
   locale. English fallback on missing.

Test pivot: a fixture user with elevated BP must surface ESH/ESC
excerpt #4 via the model's recommendation; a low-data user must NOT
surface anything (the prompt instructs an empty `recommendations[]`).

## v1.4.16 — Multi-provider redundancy

Goal: a single provider's outage no longer breaks insights generation.

### Subtasks

1. **`MultiProviderCascade` wrapper.** Implements `AIProvider`. Holds
   an ordered list of underlying providers (Codex, OpenAI, Anthropic,
   Local). Tries each in order; on transient error (5xx, 429,
   `slug_rejected_503` from the new chain), falls through to the
   next. On terminal-but-permission error (401, 403), surfaces
   verbatim — no fall-through (the user has to fix the credential).

2. **Selection policy in admin settings.** Admin can pick the cascade
   order in `/admin/integrations`. Default: user's chosen primary,
   then the admin OpenAI key, then any other connected per-user
   provider.

3. **Cost / latency budget.** Cascade only kicks in on hard error,
   never on schema-mismatch (the strict-schema retry already handles
   that). Per-request total wall-clock budget: 60 s.

4. **Telemetry.** Wide-Event `ai.cascade.attempts: ["codex","admin-key"]`
   + `ai.cascade.outcome: "success" | "all-failed"`.

## v1.4.16 — Per-recommendation explainability

Goal: every recommendation can answer "why did you tell me this?" in
one click.

Schema gains `recommendation[].rationale: { dataWindow, comparedTo,
deviation }`:

```ts
rationale: {
  dataWindow: "last7days",            // window the recommendation analysed
  comparedTo: "your last90days avg",  // baseline used for the call
  deviation: "+5 mmHg",               // magnitude of the divergence
}
```

UI: a small "Why?" chevron under each recommendation expands a one-
line tooltip: `"Your avg7 (78 bpm) is 5 bpm above your 90-day median
(73 bpm). That's clinically meaningful per ±5 bpm threshold (ESH/ESC
2024)."` — assembled from `rationale` + the linked reference excerpt.

## v1.4.17 — User-feedback loop

Goal: the system prompt ratchets over time based on user signals.

1. **Per-recommendation thumb-up / thumb-down** in the UI. Persisted
   in a new `InsightFeedback` table:

   ```
   id            uuid
   userId        uuid (FK)
   recommendationId   text  (the schema's stable id)
   recommendationText text  (snapshot — id is per-response, may be reused)
   helpful       bool
   createdAt     timestamp
   ```

2. **Aggregate dashboard for admin** under `/admin/ai-quality`. Shows
   helpful-rate per recommendation type (severity, metricSource.type),
   per locale, per provider type, per `PROMPT_VERSION`.

3. **Prompt revision workflow.** When a recommendation type drops
   below 60% helpful-rate over 100 ratings, an admin alert proposes
   a prompt revision — `PROMPT_VERSION` bumped, A/B-tested for one
   week, kept or reverted.

## v1.4.17 — Confidence score per recommendation

Goal: every recommendation gets a calibrated confidence score the UI
renders as a coloured pill (green ≥ 0.85, yellow 0.6-0.85, red < 0.6).

Schema: `recommendation[].confidence: number ∈ [0, 1]`. Threshold
calibration done from the v1.4.17 feedback loop's ground-truth ratings.

This is NOT the same as the legacy `dataQuality.confidence` enum (which
captures snapshot density, not per-recommendation confidence).

## v1.5 — Optional "deep mode" with reasoning

The Codex protocol supports `reasoning` summaries (§1a of the spec).
We currently emit `reasoning: null` to keep responses fast and cheap.
v1.5 introduces an opt-in "Deep analysis" toggle in Settings that
switches `reasoning: { effort: "medium", summary: "concise" }` on,
fetches the reasoning channel separately, and renders a collapsed
"Show reasoning" section under each insight. Reasoning content goes
into a separate `reasoning` schema field — never folded into
`summary`.

This is gated behind a per-user setting because reasoning costs ~5x
more tokens.

## Discoverability sanity-check

Before each iteration: re-fetch
`gh api repos/openai/codex/contents/codex-rs/models-manager/models.json`
and update `DEFAULT_SLUG_FALLBACK_CHAIN`. The chain was correct for
the 2026-05-09 allow-list snapshot; future drift is automatically
absorbed by the cache + walk, but the **default order** should still
match upstream's "default plan" preference so a freshly-deployed
instance never has to walk on its first request.

## What's NOT on the roadmap

- **Self-hosted fine-tuning.** Out of scope — HealthLog's user base
  doesn't justify training cost.
- **Image input.** Snapshots are numeric; image processing belongs to
  a separate "doctor-report scan" feature.
- **Conversational memory.** Insights are stateless per call. The
  multi-turn UX is owned by a future `/coach` route, not the
  insights generator.

---

Owner: Marc + future-Phase-C agent. Cross-link from
`.planning/phase-C1-report.md` and the v1.4.15 release notes.
