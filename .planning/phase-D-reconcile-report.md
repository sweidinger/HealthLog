# Phase D — Reconcile report (v1.4.16)

Reviewer: phase-D reconcile agent (sequential after the 6 parallel
reviewers + Product-Lead).
Inputs: `phase-D-{code-review,security,design,senior-dev,simplify,
product-lead-review}-findings.md`.
Constraint: charts data-presentation can change in v1.4.16; visual
style stays Dracula. No new dependencies. Pre-commit hooks must run;
no `--no-verify`, no `--no-gpg-sign`.

Verdict: 1 of 3 CRITICAL fixed inline (C3 on-surface comparison
toggle). 2 of 3 deferred to v1.4.17 with documented rationale.
9 HIGH fixed, 12 deferred. 7 of 8 simplify-yes applied.

---

## CRITICAL — status per finding

### C1 — `/insights` does NOT mount the polished `<InsightAdvisorCard>` / grid / RecCard / ConfidenceMeter / Feedback. **DEFERRED**

Wider-than-reasonable-scope-tonight. The `/insights` page consumes 7
distinct per-status endpoints (`/api/insights/{general,blood-pressure,
weight,pulse,bmi,mood,medication-compliance}-status`) returning text-
only payloads. Mounting `<InsightAdvisorCard>` requires either
rewriting all 7 status endpoints to return the
rationale+confidence+citation rich shape, OR migrating the page to
consume `/api/insights/generate`'s comprehensive payload directly.
Same v1.4.17 migration the senior-dev review and code-review (H3)
flagged.

**Workaround applied:** v1.4.16 release notes / Marc-Brief MUST phrase
the polish components as "groundwork for v1.4.17 user-facing rollout"
rather than headline UX. Screenshots of the unmounted advisor card
surface do NOT belong in v1.4.16 marketing material. Logged to
`v15-backlog.md` from-design section.

### C2 — `<InsightsCardPreview>` (dashboard insights tile) has zero live imports. **DEFERRED**

Same root cause as C1. Mounting on `/` requires a new GET endpoint
exposing `User.insightsCachedText` + cache-aware staleness markers
(the existing `/api/insights/generate` is POST mutation-only).
Logged to `v15-backlog.md`.

### C3 — Comparison toggle has NO on-surface control (buried 3 clicks deep). **FIXED**

Commit `6e74d38` `fix(design): on-surface comparison toggle on
dashboard + insights (C3)`. New `<CompareToggle>` segmented control
(None / Vormonat / Vorjahr) mounted next to dashboard greeting and
on `/insights` page hero. Persists via the same
`/api/dashboard/widgets` PUT the Settings section uses, with
optimistic update + cache invalidation. 44 px tap targets,
focus-visible ring, role=group + aria-label, EN+DE i18n. 6 SSR
tests pin segment count, persisted-active state, tap-target floor,
EN+DE labels, and ARIA shape.

---

## HIGH — triage table

| #   | Source      | Finding                                            | Action                                                     | Commit    |
| --- | ----------- | -------------------------------------------------- | ---------------------------------------------------------- | --------- |
| H1  | code-review | feedback-aggregator bucket-key collision           | **already-fixed** (reviewer mis-read; SOH `\x01` in code)  | n/a       |
| H2  | code-review | FallbackChainCard discards `enabled` flag          | **fixed**                                                  | `5f7b9d8` |
| H3  | code-review | Strict B5b/c/d AI features dark in production      | **deferred** → v1.4.17 (route migration)                   | n/a       |
| H4  | code-review | findRecommendationsMissingRationale always-empty   | **deferred** → v1.4.17                                     | n/a       |
| H5  | code-review | feedback endpoint had no rate-limit                | **fixed**                                                  | `6863ecb` |
| H6  | code-review | feedback over-broad cache invalidation             | **fixed**                                                  | `6863ecb` |
| H7  | code-review | comparison overlay shifts current data forward     | **deferred** (needs upstream-fetcher audit)                | n/a       |
| H8  | code-review | seedKey race in ai-section                         | **deferred**                                               | n/a       |
| H1  | security    | meta + action.details not redacted at admin egress | **fixed**                                                  | `fb12f09` |
| H2  | security    | `/api/admin/audit-log` raw `details` returned      | **fixed**                                                  | `fb12f09` |
| H1  | design      | rec-feedback thumbs 28×28 px                       | **fixed**                                                  | `c3451a4` |
| H2  | design      | rec-card chevron 24×24 px                          | **fixed**                                                  | `c3451a4` |
| H3  | design      | trend-card aria-label hardcoded English            | **fixed**                                                  | `2f057f4` |
| H4  | design      | medication-compliance no compareBaseline overlay   | **fixed** (caption added)                                  | `5661439` |
| H5  | design      | InsightsPageHero gradient too faint                | **deferred** → v1.4.17 visual sweep                        | n/a       |
| H6  | design      | Chart range tabs 36×~28 px                         | **fixed**                                                  | `c3451a4` |
| H7  | design      | Medication CSV raw `<input type="checkbox">`       | **fixed** (Switch + min-h-11)                              | `c3451a4` |
| H8  | design      | DE fallback-chain row Pixel-5 overflow             | **deferred** (premise partly mistaken — buttons icon-only) | n/a       |
| H1  | senior-dev  | `src/lib/ai/` 19 flat files architectural pressure | **deferred** → v1.4.17                                     | n/a       |
| H2  | senior-dev  | `<InsightAdvisorCard>` 690-line god-component      | **deferred** → v1.4.17                                     | n/a       |
| H3  | senior-dev  | `<RecommendationCard>` approaching size            | **deferred** → v1.4.17                                     | n/a       |

**Tally: 9 HIGH fixed, 1 already-fixed (mis-read), 11 deferred to v15-backlog.md.**

---

## Simplify-yes — applied

7 of 8 apply-yes findings landed in commit `f3025a8`
`refactor(v1.4.16): apply simplify-review safe suggestions`:

- F2 — `confidenceContext` config-bag dropped from `generateInsight()`.
  2 confidence-wrapper tests rewritten to test parsed-payload path.
- F3 — `aiRecommendationRationaleSchema.referenceId` speculative
  optional dropped.
- F4 — `applyLastWorkingCache` doc-comment trimmed.
- F5 — `<RecommendationFeedback>` re-uses canonical
  `RecommendationFeedbackRequest` types.
- F6 — `formatRelativeTime` doc-comment trimmed (stale polyfill claim).
- F7 — `<RecommendationCard>` 26-line slot-architecture header → 4-line
  WHY.
- F9 — `pickProviderType` mis-anchored PROMPT_VERSION paragraph
  removed.
- F10 — `legacy-payload.ts` `UnknownRec` interface inlined.
- F12 — `<ConfidenceMeter>` 20-line band-policy header → 3-line WHY.

(F1 + F8 are apply-no — both flagged for Marc's call. Logged to
v15-backlog.md "from-simplify" section.)

**0 reverts.** All landed cleanly with full test suite green per-step.

---

## Final verification

Run after all reconcile commits land. See "Final verification" status
block at the bottom of this document for actual numbers.

Cleanup note: removed orphan `src/components/settings/thresholds-
settings-section.tsx` (untracked leftover from B6's renaming refactor —
was blocking typecheck against the new layout).

Untracked dotted-segment route directories (`src/app/api/export/
{measurements,medications,mood}.csv/`, `full-backup.json/`) are
pre-existing v1.4.16 leftovers from B7's plain-segment pivot. Left in
place — not in scope for reconcile, but flagged for v1.4.17 cleanup.

---

## Pointer to v15-backlog.md

Full deferred-item inventory at
`.planning/v15-backlog.md`. Sections:

- from-Product-Lead-strategic (C.1–C.11 + v1.6+ initiatives)
- from-design (deferred CRITICALs C1+C2 + HIGH/MED + 22 MED/LOW)
- from-code-review HIGH/MED
- from-security HIGH/MED
- from-senior-dev HIGH (architecture splits) / MED / LOW
- from-simplify (the 2 apply-no items)
- from-Wave-C deferred (Coolify image-digest, ARM matrix)

---

## Product-Lead review's standing

`.planning/phase-D-product-lead-review.md` IS the strategic v1.5
plan. No compaction needed. The reconcile report's Pointer section
defers to it as the source-of-truth for v1.5 milestone planning.
Marc-three-weeks-from-now reads it as-is to remember "what state is
the app in, and what does v1.5 actually need to look like".
