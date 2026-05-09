# Phase B5b — Multi-provider redundancy (v1.4.16)

Completed 2026-05-10 ~00:40 CEST.

## What landed

Four atomic commits on origin/main, each TDD-first (failing test then fix):

| #   | Commit                                                                                                                          | What it ships                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `2611bb4 feat(db): User.aiProviderChain for ordered fallback config`                                                            | New `User.aiProviderChain` JSONB column + migration `0033_user_ai_provider_chain`. `parseProviderChain()` defensively coerces malformed input back to `PROVIDER_CHAIN_DEFAULT` (codex → openai → anthropic → local → admin-openai). 15 unit tests. Credentials still live in the existing AES-256-GCM columns; the chain only metadata.                                                                                                |
| 2   | `901f44e feat(charts): mood chart polish ...` (cross-agent race captured the actual subject) — bundled my B5b runner + route work | `src/lib/ai/provider-runner.ts` exports `runWithFallback()` (strict-schema variant, used when the route migrates to `generateInsight()` in B5c) AND `runRawCompletionWithFallback()` (legacy-shape variant the current route consumes). Hard-fail policy: 401/403/429/5xx/transport cascade; schema 422 bubbles. Last-working-provider cache: 1h TTL, in-process per-userId. Five `ai_chain_*` Wide-Event annotations per generation. |
| 3   | `613d661 feat(settings): minimal display of active AI provider + configured chain`                                              | New `GET /api/insights/provider-chain` returns `{ activeProvider, cachedActiveProvider, configuredChain }`. `<ProviderChainSummary>` subcomponent in `<AiSection>` renders "Active provider: ChatGPT (Codex)" + "Configured chain: ..." with a "(cached: …)" suffix when the runner has rerouted. EN+DE i18n keys under `settings.ai.providerChain.*`. Hides itself when no provider is configured.                                     |
| 4   | `d2bda42 test(ai): provider fallback covers happy path, hard-fail cascade, cache`                                               | Integration test against the postgres testcontainer with two user-level providers (openai + anthropic) and a fetch-spy intercept routing on URL prefix. Three scenarios pinned: hard-fail-then-success cascade, all-fail cascade, and last-working-cache reorder.                                                                                                                                                                      |

## Verification

- `pnpm test` — 1299/1299 unit tests pass (was 1199 baseline → +100 net for B5a+B5b combined; B5b's contribution is +51: 15 chain-parse + 18 runner + 5 chain-resolver + 3 provider-chain endpoint + 4 audit-log/route assertions added to existing route test + integration test).
- `pnpm test:integration` — 53/53 (14 files, was 50 → +3 for the chain integration suite).
- `pnpm typecheck` — only pre-existing error from B6's untracked `thresholds-settings-section.tsx` (TS2322 on a missing `id` prop). My code is clean.
- `pnpm lint` — 12 pre-existing warnings / 0 errors.

## Cross-agent race notes

Same pattern as B5a documented:

1. Commit 2 was hijacked by another agent's parallel staging — landed under the subject `feat(charts): mood chart polish with emoji glyphs at data points` (`901f44e`). My B5b runner / route / resolveProviderChain code IS in that commit (verified via `git show 901f44e:src/lib/ai/provider-runner.ts`); the parallel agent's mood-chart polish files landed alongside. Subject is misleading; diff is correct.
2. An earlier in-flight stash by the B6 settings agent dropped my route + provider edits onto a stash mixed with B6's settings refactor. Recovered by replaying my changes from scratch — Commit 1 (`2611bb4`) survived; Commit 2 had to be re-typed.
3. The Wave-A → Wave-B verification gate's stash/restore loop (`wave-a-gate-stash-*`) sat at the bottom of `git stash list` and never poisoned my work this round.

The cross-agent worktree adoption deferred from v1.4.15 → v1.4.16 → … is now overdue. Each parallel-marathon phase has eaten a recurring 15-30 min on this exact race.

## What B5c+ inherits

- `runWithFallback()` (strict variant) is ready for B5c's wrapper-migration of `/api/insights/generate` — it returns the same `GenerateInsightOutcome` shape plus `workingProvider` and `fallbackHops`. B5c just swaps `runRawCompletionWithFallback()` → `runWithFallback()` once the route consumes the strict schema.
- `RecommendationFeedback.providerType` (B5e research §3.B) reads off `result.workingProvider.providerType` — the chain runner already returns it as part of the outcome, so B5e's feedback-attribution code path doesn't need a separate query.
- B5a's `MEDICAL_REFERENCES` and the enriched system prompt feed every chain entry transparently (the runner doesn't touch the prompt; each provider receives the same `CompletionParams`). No additional plumbing needed.
- The cache is in-process per worker; v1.4.17 multi-tenant work (Redis-backed sessions etc.) should move it to a shared store if HealthLog ever runs ≥2 workers.
