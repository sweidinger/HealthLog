# Phase C1 — AI/Codex hardening (v1.4.15 infrastructure)

Status: done
Last update: 2026-05-09T22:00:00+02:00
Owner: Phase C1 agent (Claude Opus 4.7)

## Marc's mandate (verbatim)

> "Die Integration des Slug Drift Risiko darf halt immer überhaupt
> nicht sein. Das soll nicht funktional sein, sondern das soll stark
> sein. ... Es darf null Halluzinationen haben und es muss sich halt
> irgendwie stützen auf medizinische Dinge. Ich möchte da eine gewisse
> Dynamik drin haben."

Translation: slug-drift risk must vanish; AI must move FUNCTIONAL →
STRONG; zero hallucinations; ground on medical facts; some dynamism.
Multi-iteration acceptable.

v1.4.15 ships **infrastructure**. Medical-reference grounding (AHA /
ESH excerpts as system context) and full multi-provider redundancy
land in v1.4.16+ — see `docs/audit/v1416-ai-roadmap.md`.

## Commits (in order)

| Commit                                    | Subject                                                                        | Role                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `27310e4`                                 | refactor(ai): consolidate providers behind AIProvider interface                | MockAIProvider + 7 contract tests (every provider satisfies CompletionResult shape)        |
| `5510ed5` (sibling-merged, scope is mine) | docs(audit): v1.4.15 empty-states audit + i18n keys                            | swept in my schema.ts + generate-insight.ts + generate-insight.test.ts (parallel-agent race) |
| `d657f79`                                 | feat(ai): enforce citation-from-data on every recommendation                   | 11-test invariant suite — schema rejects missing/empty metricSource; cross-check enforced |
| `4e85c38`                                 | feat(ai): scope-hardened system prompt with refusal pattern                    | Versioned prompt at `src/lib/ai/prompts/insight-generator.ts` (`PROMPT_VERSION = "4.15.0"`) + 18 tests |
| `4bba951`                                 | feat(ai): fallback-chain slug discovery with 1h positive cache                 | `CodexClient` walks fallback chain + cache; spec §7b extended; 20 tests                    |
| `fa11f10`                                 | docs(audit): v1.4.16 AI hardening roadmap                                      | Iteration plan Marc explicitly invited                                                     |

Cross-agent observation: same shared-cwd race documented across A2 /
A4 / B-mobile / B1-B6 / C2 / C3 / C4 / B5 of the v1.4.15 marathon
struck commit 2 — my schema.ts + generate-insight.ts + the 11-test
file got swept into a sibling agent's `docs(audit): v1.4.15 empty-
states audit + i18n keys` commit `5510ed5`. The diff is correct on
`origin/main` (verified via `git ls-files src/lib/ai/`), only the
commit-message scope is misleading. v1.4.16 should adopt
`superpowers:using-git-worktrees` per parallel agent — recommendation
already echoed across the marathon's STATE log.

## Schema decisions

### Strict response schema (`src/lib/ai/schema.ts`)

```ts
{
  summary: string,                    // user-facing English/German
  recommendations: [{
    id: string,                       // stable per-response slug
    text: string,
    severity: "info" | "suggestion" | "important" | "urgent",
    metricSource: { type, timeRange, summary, n? },
  }],
  citations: [{ type, timeRange, summary }],
  warnings: [{ topic, message, severity? }],
}
```

Three-pronged guard:

1. **Required-field guard** — empty `metricSource.summary` rejected at
   parse time. The model cannot fabricate a recommendation that
   points at "nothing".
2. **Cross-check guard** — `findUncitedRecommendations()` rejects
   responses where any recommendation cites a `(type, timeRange)` not
   in `citations[]`. Two-step verification: parse → cross-check.
3. **Retry-once guard** — `generateInsight()` wraps the provider call
   and on schema failure injects the corrective context into the user
   prompt and re-tries ONCE. On second failure: throws
   `InsightSchemaError` with `httpStatus: 422` for the route.

The strict schema uses `.passthrough()` so legacy fields
(`classification`, `findings`, `correlations`, `dataQuality`,
`disclaimer`) ride along — cached payloads from v1.4.14 still hydrate
the dashboard. v1.4.16 retires `.passthrough()` once the UI migrates
to the strict shape.

### Versioned system prompt

`PROMPT_VERSION = "4.15.0"` is embedded in both locale variants and
exported for Wide-Event annotation. Future iterations bump the
revision so logs can attribute response quality to a specific prompt
version. Versioning policy documented in the prompt file's header.

### Slug fallback chain default

```ts
DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.3-codex",  // verified 2026-05-09 on Plus/Pro
  "gpt-5-codex",    // historical default — kept as second-chance retry
  "gpt-5",          // bare slug — currently rejected on ChatGPT-auth
  "gpt-4o",         // last-ditch capability fallback
]
```

Override via `CODEX_MODEL_FALLBACK_CHAIN` (comma-separated). When
`CODEX_MODEL` is also set, it folds into chain position 0; defaults
survive behind it. Stable de-duplication.

## Fallback chain rationale

Per `docs/codex-protocol-spec.md` §7b (extended in this phase):

| Status                                          | Action                                |
| ----------------------------------------------- | ------------------------------------- |
| `400` + "not supported when using Codex with a ChatGPT account" | walk |
| `400` + `model_not_found`                       | walk                                  |
| `400` + `does not exist` AND mentions a model   | walk                                  |
| `404`                                           | walk                                  |
| `401` (first time)                              | refresh and retry SAME slug; DON'T walk |
| `401` after refresh, `403`, `429`, `5xx`        | propagate (don't walk)                |
| `200` + SSE `response.failed.error.code === "invalid_prompt"` | propagate (request shape is wrong) |

Positive cache: process-local Map at `src/lib/ai/codex-slug-cache.ts`,
single slot, 1 h TTL. Cache hit makes the working slug come first on
the next call. Cache invalidated on first slug-rejection walk.

All-failed: structured 503 with `attempted: string[]`,
`httpStatus: 503`, message `"AI provider unreachable — all configured
Codex slugs were rejected"`. The route layer surfaces "AI provider
unreachable — check Settings".

The auth path (401 → refresh + retry SAME slug) is preserved verbatim
from v1.4.7..v1.4.13 — auth-state failures don't get fixed by walking
the slug chain. Subtle but load-bearing.

Diagnostics: `client.getLastDiagnostics()` returns
`{ attempted, cacheState, workingSlug }` for Wide-Event annotation.
The route at `/api/insights/generate` does NOT yet read this — adding
the annotation is a v1.4.15.1 follow-up (one-line `annotate()` call).

## Out-of-scope refusal pattern

The scope-hardened prompt instructs the model to return a fixed
refusal payload when the snapshot is empty or off-topic:

```json
{
  "summary": "I can only summarise the health metrics in your log. The submitted data did not contain measurements I can analyse.",
  "recommendations": [],
  "citations": [],
  "warnings": []
}
```

Both EN and DE variants exported as `OUT_OF_SCOPE_REFUSAL_EN/DE`.
Tests pin that the payload validates against the strict schema and
the wrapper passes it through cleanly.

## Tests added

| File                                       | Tests | Focus                                                        |
| ------------------------------------------ | ----- | ------------------------------------------------------------ |
| `provider-contract.test.ts`                | 7     | Every provider returns CompletionResult shape                |
| `mock-client.ts`                           | -     | Test infrastructure, no tests of its own (covered above)    |
| `schema.ts` (no test file)                 | -     | Tested via the next two files                               |
| `generate-insight.test.ts`                 | 11    | Schema parse, retry-once with correction, 422 on second-fail |
| `citation-enforcement.test.ts`             | 11    | Schema-level + cross-check + wrapper end-to-end             |
| `insight-generator-prompt.test.ts`         | 18    | Both locales, scope hardening, refusal payload, ESH/ESC etc. |
| `codex-slug-cache.test.ts`                 | 7     | TTL boundaries, invalidation, replacement                    |
| `codex-slug-fallback.test.ts`              | 13    | Walk triggers, no-walk on 5xx/429/401, all-failed, cache     |

Total: +67 unit tests across 6 new files. 965 → 1048 unit pass
(+83 net from baseline; some sibling-agent tests merged in too).
Integration: 31 / 31 still pass. Typecheck: no new errors. Lint: 0
errors, 11 pre-existing warnings.

## Link to v1.4.16 roadmap

`docs/audit/v1416-ai-roadmap.md` enumerates the deferred items:

1. Medical-reference grounding (hand-curated bundle of ESH/ESC, AHA,
   WHO, AASM, DGE/DEGAM excerpts; pre-flight relevance selection).
2. Multi-provider redundancy (`MultiProviderCascade` wrapping
   `AIProvider`; admin-tier ordering).
3. Per-recommendation explainability
   (`rationale.{dataWindow, comparedTo, deviation}` + UI tooltip).
4. Route-side wiring: `/api/insights/generate` adopts
   `generateInsight()` + the strict prompt; UI migrated to the new
   schema shape.
5. v1.4.17: user-feedback loop (`InsightFeedback` table, admin
   `/admin/ai-quality` dashboard, prompt-revision workflow).
6. v1.4.17: per-recommendation confidence score (calibrated from the
   feedback loop's ground-truth).
7. v1.5: optional "deep mode" with Codex reasoning summaries.

## Open / deferred

- Route-side wiring of `generateInsight()` — deferred because the
  existing UI consumes a different schema shape; would have broken
  the dashboard. v1.4.16 ships the consumer-side migration alongside
  it.
- Wide-Event annotation reading `client.getLastDiagnostics()` — one-
  line follow-up; left out of v1.4.15 to keep the AI-touching diff
  scoped to provider/wrapper/schema/prompt/cache.

## Build status

```
pnpm test           → 1048 / 1048 pass
pnpm test:integration → 31 / 31 pass
pnpm typecheck      → only pre-existing dashboard-layout.test.ts errors (A4-owned)
pnpm lint           → 0 errors, 11 pre-existing warnings
```

All 6 commits on `origin/main`, each pushed cleanly after rebase-with-
autostash. No `--no-verify`, no `--no-gpg-sign`, no force pushes.
