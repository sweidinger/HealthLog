# v1.11.1 W10 QA LEDGER

## Reviewers (6): qa-code-review, qa-security, qa-senior-dev, qa-product-lead, qa-simplifier, qa-i18n-deadcode
Verdicts so far: security PASS (0C/0H/0M), code-review SHIP (0C/0H/1M), product-lead SHIP (0C/0H/2M), senior-dev ship-able (0C/0H/1M). simplifier + i18n pending.

## RECONCILED (fixed this session)
- [FIXED commit pending] M (code-review M-1 / security Info-1 / product-lead M2 / senior-dev L2): conversation-summary.ts fold-loop decrypt not fault-isolated → wrapped in try/catch (flatMap skip). 4 reviewers flagged same spot.
- [FIXED] M (senior-dev): live/rollup tiebreak divergence for ranked types with only off-ladder sources → unified JS collapse + rollup all-time SQL on `source` ASC (matches canonicalMeasurementsFrom + route CTE). Unit test updated.
- [FIXED] L (security L-1): stale `/^[A-Z_]+$/` doc comment in source-rank-sql.ts → `/^[A-Z0-9_]+$/`.

## MUST DO IN RELEASE COMMIT (product-lead M1)
- bump package.json 1.11.0→1.11.1 + `pnpm openapi:generate` (else openapi:check reds — v1.6.0/v1.8.5 trap).

## DEFERRED (Low — backlog, documented)
- code-review L-2 / fast-path redundant loadUserSourcePriority lookups (perf nit; thread userPriorityJson param) — defer.
- code-review L-3 / facts soft-cap drifts >50 (injection bounded top-8) — defer.
- code-review L-4 / route rollup read dropped take:cap (window-bounded) — defer.
- senior-dev L1 / 60s snapshot cache vs fact-delete (≤60s staleness) — CHANGELOG note.
- senior-dev L3 / groupBy=day list view sums all sources while chart is source-aware — defer + note (raw-data view vs canonical chart).
- senior-dev L4 / pre-existing delete-then-insert P2002 race widened by per-source range delete (queue retry mitigates) — defer.
- security Low-2/Info — central redaction covers worker err.message; background-only.
- CHANGELOG known-limitations: latest-tile canonical-source shift (intended R1) + 60s fact-deletion staleness.

## PENDING: read qa-simplifier.md + qa-i18n-deadcode.md when they land; reconcile any new Medium+.

## LAST 2 REVIEWERS (simplifier + i18n/knip) — reconciled
- [FIXED] HIGH (i18n/knip + simplifier S1): 3 net-new unused exports failing the enforcing knip Dead-code CI gate — SUMMARY_PROMPT_VERSION + SUMMARY_TARGET_CHARS (conversation-summary.ts) + FACTS_PROMPT_VERSION (facts.ts). Fix: deleted the 2 pure version constants (no consumer), and CONSUMED SUMMARY_TARGET_CHARS as a real safety cap on the stored summary length. Post-fix knip: 3 gone, exit clean. typecheck clean, 47 compute tests green.
- [DEFERRED — Low/perf, rationale] simplifier S2 / code-review L-2: the userPriorityJson load-once param is threaded by zero callers → fast-paths make 2-4 redundant loadUserSourcePriority lookups/request. Split rating (code-review Low, simplifier Medium); impact = sub-ms indexed PK reads, NOT correctness/security/safety; the param already exists for when it matters. Deferred to backlog to avoid ship-time scope creep across 3 loop sites.
- [DEFERRED — Low] simplifier: ExtractOpts.now dead field (facts.ts) — harmless forward-compat; stale measurement-read.ts docstring ("max count" vs source-name tiebreak) — cosmetic; residual hand-inlined canonicalMeasurementsFrom copy in summaries-slice — equivalent SQL. All Low, backlogged.
- i18n: CLEAN (zero new t() calls, no UI files, prompts server-composed). openapi:check IN SYNC.

## FINAL QA TALLY: 0 Critical / 0 High open / 0 Medium open. All Medium+ reconciled (decrypt isolation, tiebreak parity, knip unused exports). Lows deferred with rationale. SHIP-CLEARED.
