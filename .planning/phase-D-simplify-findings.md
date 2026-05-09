# Phase D — Simplify/Refine review findings (v1.4.15)

Reviewer: simplify agent (parallel — 1 of 5)
Scope: `git diff --name-only v1.4.14...HEAD` — v1.4.15 changed source files only.
Constraint: chart presentation (`src/components/charts/**`) explicitly approved this milestone — not flagged.
Mode: autonomous, no commits, no edits — output only.

Findings ordered roughly by impact. "Apply autonomously? yes" = low-risk delete / inline; "no" = needs Marc's call.

---

## Finding 1 — Schema-enforcement wrapper (`generateInsight`) is wired into tests only

**Files:**

- `src/lib/ai/generate-insight.ts` (entire file, 176 LOC)
- `src/lib/ai/schema.ts` (entire file, 182 LOC — 4 zod schemas + `findUncitedRecommendations` + `InsightSchemaError`)
- `src/lib/ai/prompts/insight-generator.ts` (entire file, 267 LOC — `getStrictInsightsSystemPrompt`, `OUT_OF_SCOPE_REFUSAL_*`, `PROMPT_VERSION`)
- `src/lib/ai/mock-client.ts` (entire file, 103 LOC — `MockAIProvider`)

**Type:** dead / speculative

**Why it's a smell:** Every export from these four files is consumed only by the v1.4.15 test suite. Production routes (`src/app/api/insights/**`) do not call `generateInsight()`, do not use `getStrictInsightsSystemPrompt()`, and do not import `aiInsightResponseSchema`. The schema-enforced retry-once + citation cross-check + zero-hallucination prompt is pure scaffolding for v1.4.16 (per the prompt-file's own commentary: "Use this in place of the legacy `getInsightsSystemPrompt` once the route migrates to `generateInsight()` (planned v1.4.16)").

CLAUDE.md: "Don't add features, refactor, or introduce abstractions beyond what the task requires" + "Don't add error handling, fallbacks, or validation for scenarios that can't happen" — the four files together add ~728 LOC of validation + retry + prompt-versioning that no production code path can reach.

Verified:

```
$ grep -rn "generateInsight\|getStrictInsightsSystemPrompt\|aiInsightResponseSchema\|InsightSchemaError\|MockAIProvider" src/app
(no output)
```

**Suggested change:** Defer the four files (and their tests) to v1.4.16, where the route actually migrates. Either (a) revert the four `.ts` and their `__tests__/` siblings, or (b) leave them in place with a single TODO comment and acknowledge as carry-over scaffolding. Option (a) is the CLAUDE.md-aligned move.

**Risk:** medium — deletes six test files that "pass". But the production code never depends on any of it, so removal is mechanical.

**Apply autonomously?** no — Marc may have specifically wanted the test-only foundation pre-built before v1.4.16 work; checking with him saves a re-do if so.

---

## Finding 2 — `CodexClient.getLastDiagnostics()` + `CodexAttemptDiagnostics` interface are read only by tests

**File:** `src/lib/ai/codex-client.ts:101-138, 174-178, 192-198, 233-237, 242-246`

**Type:** speculative / dead

**Why it's a smell:** The diagnostics struct (`attempted[]`, `cacheState`, `workingSlug`) and `getLastDiagnostics()` getter are stored on the instance after every `generateCompletion()` call. The doc-comment says "used by the route layer for Wide-Event annotations" — but the route layer in `src/app/api/insights/**` never calls it. Only the slug-fallback unit tests read it.

Verified:

```
$ grep -rn "getLastDiagnostics\|CodexAttemptDiagnostics" src/app
(no output)
```

**Suggested change:** Either wire it into the route's `annotate()` block (closes the comment's promise) or delete `lastDiagnostics`, `getLastDiagnostics()`, and the `CodexAttemptDiagnostics` interface. The tests can be re-written to assert against `getCachedCodexSlug()` + `inspectCodexSlugCache()` which already cover the same observable surface.

**Risk:** low — telemetry-only state.

**Apply autonomously?** no — Marc may want the diagnostics in Wide Events; either direction is a small commit but it's a product-y call.

---

## Finding 3 — `inspectCodexSlugCache()` + `CODEX_SLUG_CACHE_TTL_MS` are test-only re-exports

**File:** `src/lib/ai/codex-slug-cache.ts:62-74`

**Type:** dead

**Why it's a smell:** Both exports are consumed only by `__tests__/codex-slug-fallback.test.ts`. The doc-comment for `inspectCodexSlugCache` says "Diagnostic helper — exposes (slug, ageMs) for Wide-Event annotation" but nothing in the route layer reads it. `CODEX_SLUG_CACHE_TTL_MS` exists only so a test can assert "1h per spec §7b" — that assertion can read the internal `CACHE_TTL_MS` directly via `__test` re-export pattern (already used by `codex-client.ts`).

**Suggested change:** Either (a) inline both into `codex-client.ts` `__test` block, or (b) delete `inspectCodexSlugCache` and have the test assert via `getCachedCodexSlug()` (semantically equivalent — it returns the same slug). The TTL constant can move into the test as a literal `60 * 60 * 1000` since it's only checking the documented spec value, not a runtime branch.

**Risk:** low.

**Apply autonomously?** yes (option b — delete the diagnostic helper, leave the TTL constant since it's at file scope and one line).

---

## Finding 4 — `TEST_CONSTANTS` re-export in `channel-state.ts` is unused

**File:** `src/lib/notifications/channel-state.ts:171`

```ts
export const TEST_CONSTANTS = { MAX_CONSECUTIVE_FAILURES } as const;
```

**Type:** dead

**Why it's a smell:** `MAX_CONSECUTIVE_FAILURES` is already exported from `retry-policy.ts` (the actual definition site). `TEST_CONSTANTS` is referenced by no test, no production code, no other module. Pure dead code.

```
$ grep -rn "TEST_CONSTANTS" src
src/lib/notifications/channel-state.ts:171:export const TEST_CONSTANTS = { MAX_CONSECUTIVE_FAILURES } as const;
```

**Suggested change:** Delete the line.

**Risk:** low — single-line removal.

**Apply autonomously?** yes.

---

## Finding 5 — `RejectKind` type alias is exported but never used

**File:** `src/lib/notifications/retry-policy.ts:28`

```ts
export type RejectKind = "hard" | "soft" | "ok";
```

**Type:** dead

**Why it's a smell:** Defined alongside `SendOutcome` but every consumer uses `SendOutcome.hardReject?: boolean` instead of branching on a `RejectKind` value. No code reads the alias; `Pick<SendOutcome, …>` is the actual currency.

```
$ grep -rn "RejectKind" src
src/lib/notifications/retry-policy.ts:28:export type RejectKind = "hard" | "soft" | "ok";
```

**Suggested change:** Delete the line.

**Risk:** low.

**Apply autonomously?** yes.

---

## Finding 6 — Misleading "fallback" comment on exhaustive switch

**File:** `src/lib/gamification/achievements.ts:44-48` (function `getAchievementCategory`)

```ts
/**
 * Stable metric → category mapping. Add a metric here when it joins the
 * `AchievementMetricKey` union; the page falls back to "engagement" if
 * a future definition slips through, so there is no silent drop-off.
 */
export function getAchievementCategory(
  metric: AchievementMetricKey,
): AchievementCategory {
  switch (metric) { ... } // exhaustive over the union; no default branch
}
```

**Type:** comment (WHAT not WHY, factually wrong)

**Why it's a smell:** The comment claims "the page falls back to 'engagement' if a future definition slips through" — but the implementation is an exhaustive switch over a closed union with no `default:` branch. If a metric is ever added to `AchievementMetricKey` without a case here, TypeScript will error at compile time, not silently fall through to "engagement". The comment describes a behaviour that doesn't exist.

CLAUDE.md: "Default to writing no comments. Don't explain WHAT — well-named identifiers do that."

**Suggested change:** Delete the misleading sentence. If the WHY is "stable mapping that TS guarantees exhaustiveness", trust the type system.

```diff
-/**
- * Stable metric → category mapping. Add a metric here when it joins the
- * `AchievementMetricKey` union; the page falls back to "engagement" if
- * a future definition slips through, so there is no silent drop-off.
- */
 export function getAchievementCategory(
   metric: AchievementMetricKey,
 ): AchievementCategory {
```

**Risk:** low.

**Apply autonomously?** yes.

---

## Finding 7 — Unreachable `default` arm in `stateBadgeFor` switch

**File:** `src/components/settings/notification-status-card.tsx:329-337`

```ts
function stateBadgeFor(state: ChannelState, t): {...} {
  switch (state) {
    case "active": return ...
    case "auto_disabled": return ...
    case "sending_paused": return ...
    case "manually_disabled":
    default:
      return { label: t("...stateManuallyDisabled"), ... };
  }
}
```

**Type:** defensive

**Why it's a smell:** `ChannelState` is a closed union of exactly four members, all explicitly cased. The `default:` collapses with `manually_disabled` and is unreachable; it muddles the four-arm-mapping by suggesting there's a fallthrough case that doesn't exist. CLAUDE.md: "Don't add error handling, fallbacks, or validation for scenarios that can't happen."

**Suggested change:** Remove the `default:` keyword (keep the `case "manually_disabled":` body). TypeScript's `switch`-exhaustiveness checking already covers the "future case forgotten" scenario.

```diff
     case "manually_disabled":
-    default:
       return {
         label: t("settings.notificationStatus.stateManuallyDisabled"),
```

**Risk:** low.

**Apply autonomously?** yes.

---

## Finding 8 — `period.since` back-compat shim duplicates `period.start`

**Files:**

- `src/lib/doctor-report-pdf-core.ts:218-221`
- `src/lib/doctor-report-pdf.ts:204-207`
- `src/lib/doctor-report-data.ts:362-369` (writes both fields)

**Type:** shim / repetition

**Why it's a smell:** v1.4.15 added explicit `period.start` / `period.end` strings to `DoctorReportData`. The aggregator writes both `since` and `start` to the same value. Both PDF render-paths then read with `data.period.start ?? data.period.since`. The fallback is permanently dead from the server side because `start` is always populated; it could only fire for "in-flight cached client payloads from a v1.4.14 build holding a `since`-only object" — but the PDF generators run AFTER the JSON arrives from `/api/doctor-report` of the SAME deploy, so the wire shape is in-sync by definition.

**Suggested change:** Drop `since` from the aggregator output (it was a v1.4.14 field, replaced; no external API consumers documented). Update both `ReportData` interface declarations to use `period.start` only, drop the `?? data.period.since` fallback in both PDF builders.

This is a bigger change because it touches the wire shape of `/api/doctor-report`. If the iOS app reads `data.period.since` it would break. Worth checking before deletion.

**Risk:** medium — requires confirming no external client (iOS app) reads `since`.

**Apply autonomously?** no.

---

## Finding 9 — `decidedFor` "previous-input" tracking in `tour-launcher.tsx` is over-engineered for a one-shot decision

**File:** `src/components/onboarding/tour-launcher.tsx:138-170`

**Type:** premature abstraction

**Why it's a smell:** The launcher tracks a `decidedFor: { userId, flag } | null` state purely so the render-phase setState block runs at most once per (user, flag) transition. But the body of that block already short-circuits on `showTour === null` (which only ever flips once: null → true|false) — so the entire `decidedFor` mechanism is guarding against a re-fire that the `showTour !== null` check already prevents. The comment even calls out "set-state-in-render pattern (mirrors `account-section.tsx`'s `seededUserId`)" — but `account-section`'s pattern there is for a per-prop-change re-seed, which is NOT what this launcher does (it decides once per mount).

**Suggested change:** Delete `decidedFor` state + setter. The render block becomes:

```ts
if (showTour === null && inputsReady && user) {
  if (user.onboardingTourCompleted || readSessionDismissed()) {
    setShowTour(false);
  } else if (justFromWizard) {
    setShowTour(false);
    setDeferredFromWizard(true);
  } else {
    setShowTour(true);
  }
}
```

**Risk:** medium — needs a re-test of the tour gating on auth-cache invalidation. The lint-rule that prompted this pattern (`react-hooks/set-state-in-effect`) is still satisfied because `showTour === null` is the gate.

**Apply autonomously?** no — touches user-visible flow gating; warrants Marc reviewing the simplified version.

---

## Finding 10 — Duplicated Withings-status reauth classifier in two files

**Files:**

- `src/lib/withings/sync.ts:240-255` (`isWithingsRefreshReauthFailure` + `extractWithingsStatus`)
- `src/app/api/withings/status/route.ts:80-92` (inline equivalent: parses `Withings\s+\w+\s+error:\s*(\d+)` and checks `100/101/102/200..299`)

**Type:** repetition

**Why it's a smell:** Two implementations of the same Withings-status decoder, both diverged from each other only in the wrap (function vs inline). Per CLAUDE.md "three similar lines is better than a premature abstraction" — this is exactly two callsites, so the existing helpers in `sync.ts` could be exported and reused, but creating a third util-file would be the over-extraction warned against. The right move is the smallest one: export the existing two helpers from `sync.ts` and import them in the status route.

**Suggested change:** Mark `isWithingsRefreshReauthFailure` and `extractWithingsStatus` as `export` in `src/lib/withings/sync.ts`, then in `src/app/api/withings/status/route.ts` replace the inline regex+conditional with `if (isWithingsRefreshReauthFailure(message)) { await markReauthRequired(...) }`.

```diff
// sync.ts
-function isWithingsRefreshReauthFailure(message: string): boolean {
+export function isWithingsRefreshReauthFailure(message: string): boolean {

// status/route.ts
-      const message = error instanceof Error ? error.message : String(error);
-      const statusMatch = /Withings\s+\w+\s+error:\s*(\d+)/.exec(message);
-      const statusCode = statusMatch
-        ? Number.parseInt(statusMatch[1], 10)
-        : NaN;
-      const isReauth =
-        Number.isFinite(statusCode) &&
-        (statusCode === 100 || ...);
-      if (isReauth) {
+      const message = error instanceof Error ? error.message : String(error);
+      if (isWithingsRefreshReauthFailure(message)) {
         await markReauthRequired(user.id, "withings", message).catch(() => {});
       }
```

**Risk:** low — pure rename + one-line export.

**Apply autonomously?** yes.

---

## Finding 11 — Practice-name persistence block is duplicated across two routes

**Files:**

- `src/app/api/doctor-report/route.ts:55-69`
- `src/app/api/doctor-report/pdf/route.ts:50-60`

**Type:** repetition (NOT a finding to apply)

**Why it's NOT a smell yet:** Two callsites with five-line bodies. CLAUDE.md: "Three similar lines is better than a premature abstraction." Two callers ≠ three; the abstraction (a helper in `doctor-report-data.ts`) would be premature.

**Suggested change:** None. Watch — if a third doctor-report endpoint is added (e.g. share-link variant), extract then.

**Apply autonomously?** N/A — explicit anti-finding for record-keeping so the next reviewer doesn't propose the abstraction.

---

## Finding 12 — `MockAIProvider.callCount` getter shadows `calls.length`

**File:** `src/lib/ai/mock-client.ts:99-102`

```ts
/** Number of times `generateCompletion` was invoked. */
get callCount(): number {
  return this.calls.length;
}
```

**Type:** comment (WHAT) + dead

**Why it's a smell:** The `calls: CompletionParams[]` array is already public; tests can read `provider.calls.length` directly. The getter exists only so a test can write `provider.callCount` instead of `provider.calls.length` — that's a synonym, not a feature. (Compounds with Finding 1: the entire mock is test-only anyway, so this is a cleanup that only matters if Finding 1 is rejected.)

**Suggested change:** If Finding 1 rejected: delete `callCount` getter + the docstring; have tests read `provider.calls.length`.

**Risk:** low.

**Apply autonomously?** yes (only if Finding 1 is rejected; otherwise the whole file goes).

---

## Anti-findings (deliberately NOT flagged)

- **`tour-state.ts` (B5)** — Heavily commented (one block per export averaging 6 lines), but each comment explains WHY (e.g. why `data-tour-id` not class names, why outcome is `"completed"|"skipped"` even though the DB write is identical, why `prevStep` no-ops at index 0). These are genuine WHY notes that future readers will need; CLAUDE.md targets WHAT-comments, not WHY.
- **`computeBpInTargetPct` (analytics/bp-in-target.ts)** — pure helper extracted from a route; replaces a known-buggy inline implementation. Long doc-comment explains the v1.4.14 bug and the fix rationale (WHY). Justified.
- **`integrations/status.ts` `formatAdminAlertPayload`** — pure formatter exported for unit-testing the message shape without standing up Prisma. Single-callsite extraction, but the test value is real and the surface is narrow. Justified.
- **`channel-state.ts` `recordChannelHardReject` / `recordChannelTransientFailure` / `recordChannelSuccess`** — three mutations consumed exactly once each by `dispatcher.ts`. Borderline single-callsite helpers, BUT each one is non-trivial (5+ lines of Prisma + auditLog + branching) and the dispatcher would otherwise be 60 LOC longer with auth/audit interleaved. Refactor pulls weight.
- **`generateAdminAlert` flow** — already wired into production via `recordSyncFailure` → `maybeAlertAdmins`. Real consumer.

---

## Summary

| # | File:Line | Apply autonomously? |
|---|-----------|---------------------|
| 1 | `src/lib/ai/{generate-insight,schema,mock-client}.ts` + `src/lib/ai/prompts/insight-generator.ts` | no |
| 2 | `src/lib/ai/codex-client.ts:101-138, 174-178, 192-198, 233-237, 242-246` | no |
| 3 | `src/lib/ai/codex-slug-cache.ts:62-72` | yes |
| 4 | `src/lib/notifications/channel-state.ts:171` | yes |
| 5 | `src/lib/notifications/retry-policy.ts:28` | yes |
| 6 | `src/lib/gamification/achievements.ts:44-48` | yes |
| 7 | `src/components/settings/notification-status-card.tsx:329-337` | yes |
| 8 | `src/lib/doctor-report-{data,pdf,pdf-core}.ts` (`period.since` shim) | no |
| 9 | `src/components/onboarding/tour-launcher.tsx:138-170` | no |
| 10 | `src/lib/withings/sync.ts` + `src/app/api/withings/status/route.ts` | yes |
| 11 | (anti-finding — practice-name dedupe NOT proposed) | n/a |
| 12 | `src/lib/ai/mock-client.ts:99-102` | yes (only if F1 rejected) |

**6 yes / 4 no** (excluding anti-findings 11, and 12 which is conditional).
