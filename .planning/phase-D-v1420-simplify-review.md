# Phase D — Simplify review (v1.4.20)

Lens: every chunk of new code that v1.4.20 added (Wave B = B1–B5).
Read-only review — write findings, do NOT commit. Security paths,
chart visual identity, fixture data, and the genuinely new
abstractions (`correlations.ts`, `health-score.ts`) get extra room.

## Summary

Total findings: **5 apply-yes** · **4 apply-maybe** · **3 apply-no**

apply-yes are the clear wins worth folding into reconcile. apply-maybe
flags judgement calls (test seams vs. dead parameters, premature
extraction). apply-no documents what was looked at and rejected so the
maintainer's diff isn't asked the same question twice.

---

## apply-yes (clear wins, ship in reconcile)

### S-01 — Drop unused `snapshot` parameter from `streamProviderError`

**File**: `src/app/api/insights/chat/route.ts:406-427`
**Why**: The function takes a `snapshot: ReturnType<typeof Object.assign>` parameter (which evaluates to `any` — a type smell on its own) and never reads it inside the body. Three callers dutifully pass `snapshot.provenance` for nothing. Pure dead code on both sides of the call.

**Before** (≤8 lines):
```ts
function streamProviderError(args: {
  conversationId: string;
  snapshot: ReturnType<typeof Object.assign>;
  code: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try { controller.enqueue(encodeFrame({ type: "error", code: args.code, message: args.code })); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, { status: 503, headers: SSE_HEADERS });
}
```

**After** (≤8 lines):
```ts
function streamProviderError(args: { code: string }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try { controller.enqueue(encodeFrame({ type: "error", code: args.code, message: args.code })); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, { status: 503, headers: SSE_HEADERS });
}
```

(All three call sites drop `snapshot:`/`conversationId:` keys too — `conversationId` is also unused, only `code` survives.)

---

### S-02 — Extract the duplicated `formatRelativeTime` helper

**File**: `src/components/insights/{hero-strip.tsx:134-148, daily-briefing.tsx:259-273, coach-panel/history-rail.tsx:40-54}` (also still present in the deprecated `insights-page-hero.tsx:64-86`)
**Why**: Three live byte-identical copies of the same 14-line helper. Each comment even calls out "Mirrors the helper in `<InsightsPageHero>`" — the maintainers know it's duplicated. Drift risk: a later i18n key change has to land in three files.

**Before** (≤8 lines, repeated 3×):
```ts
function formatRelativeTime(iso: string, t: …): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = Date.now() - target;
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t("insights.relativeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("insights.relativeHoursAgo", { count: hours });
  return t("insights.relativeDaysAgo", { count: Math.floor(hours / 24) });
}
```

**After** (≤8 lines):
```ts
// new file: src/lib/i18n/relative-time.ts
export function formatRelativeTime(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string { /* …same body, written once… */ }

// callers: import { formatRelativeTime } from "@/lib/i18n/relative-time";
```

---

### S-03 — Drop the dead `["coachConversation", "null"]` queryKey branch

**File**: `src/components/insights/coach-panel/use-coach.ts:83-98`
**Why**: The hook ternary picks a different queryKey when `id` is null — but `enabled: id !== null` keeps the query disabled in that exact case, so the "null" key never gets a queryFn fire. Just key on `id` directly; React Query happily accepts `null` in the array.

**Before**:
```ts
return useQuery({
  queryKey: id ? QUERY_KEYS.one(id) : ["coachConversation", "null"],
  queryFn: async () => { if (!id) throw new Error("missing id"); … },
  enabled: id !== null,
  staleTime: 60 * 1000,
});
```

**After**:
```ts
return useQuery({
  queryKey: ["coachConversation", id] as const,
  queryFn: async () => { if (!id) throw new Error("missing id"); … },
  enabled: id !== null,
  staleTime: 60 * 1000,
});
```

---

### S-04 — Hoist `STORYBOARD_COLOR_BY_CATEGORY` to module scope

**File**: `src/app/insights/page.tsx:915-920`
**Why**: The map is declared inside the component body so it's recreated on every render of `<InsightsPage>` (a render-heavy page). Map is data-only — no closures over locals, no i18n keys. Module-scope `const` is the boring right answer.

**Before**:
```tsx
export default function InsightsPage() {
  // …200+ lines of derived state…
  const STORYBOARD_COLOR_BY_CATEGORY: Record<string, string> = {
    medication: "var(--dracula-pink)", event: "var(--dracula-cyan)",
    milestone: "var(--dracula-green)", warning: "var(--dracula-orange)",
  };
}
```

**After**:
```tsx
const STORYBOARD_COLOR_BY_CATEGORY: Record<string, string> = {
  medication: "var(--dracula-pink)", event: "var(--dracula-cyan)",
  milestone: "var(--dracula-green)", warning: "var(--dracula-orange)",
};

export default function InsightsPage() { /* … */ }
```

---

### S-05 — Extract the confidence-band class+label table

**File**: `src/components/insights/{correlation-card.tsx:61-73, trend-annotation.tsx:33-46}`
**Why**: Both cards declare the same `Record<"low"|"moderate"|"high", string>` for badge classes AND for translation-key labels — byte-identical class strings, only the i18n key prefix differs (`correlationRow.*` vs `trendAnnotation.*`). Move the classnames to one constant, keep each component's i18n key map local (it IS distinct copy). The class table is the load-bearing duplication.

**Before** (one of two copies, each ~14 lines):
```tsx
const CONFIDENCE_BADGE_CLASSNAME: Record<"low" | "moderate" | "high", string> = {
  high: "border-dracula-green/40 bg-dracula-green/10 text-dracula-green",
  moderate: "border-dracula-orange/40 bg-dracula-orange/10 text-dracula-orange",
  low: "border-dracula-comment/40 bg-dracula-comment/10 text-muted-foreground",
};
```

**After**:
```tsx
// new file: src/components/insights/confidence-badge.ts
export type ConfidenceBand = "low" | "moderate" | "high";
export const CONFIDENCE_BADGE_CLASS: Record<ConfidenceBand, string> = {
  high: "border-dracula-green/40 bg-dracula-green/10 text-dracula-green",
  moderate: "border-dracula-orange/40 bg-dracula-orange/10 text-dracula-orange",
  low: "border-dracula-comment/40 bg-dracula-comment/10 text-muted-foreground",
};
```

---

## apply-maybe (judgment calls)

### S-06 — `<CoachDrawer>` slot props (`historyRail` / `sourcesRail` / `composer`) are dead in production

**File**: `src/components/insights/coach-panel/coach-drawer.tsx:53-63, 200-228`
**Why**: The only production caller (`/insights/page.tsx:1611`) never passes these slots — the JSDoc says they were a commit-2 boundary "until commit 3 lands". Commit 3 has long since landed. `<CoachDrawerBody>` has its own slot props which the SSR test harness uses; nobody injects against `<CoachDrawer>`. Removing them halves the prop surface.

**Before** (≤8 lines):
```tsx
historyRail?: React.ReactNode;
sourcesRail?: React.ReactNode;
composer?: React.ReactNode;
// …
historyRail={historyRail ?? <HistoryRail … />}
sourcesRail={sourcesRail ?? <SourcesRail />}
composer={composer ?? <CoachInput … />}
```

**After** (≤8 lines):
```tsx
// drop the three props on CoachDrawer entirely
historyRail={<HistoryRail … />}
sourcesRail={<SourcesRail />}
composer={<CoachInput … />}
```

**Why "maybe"**: keeping them costs little; the trade-off is "future test seam" vs. "delete dead code now". Given `<CoachDrawerBody>` already exposes the equivalent seams for tests, I'd ship this. But a maintainer who wants to keep the prop-injection contract symmetric across the two components has a defensible counter-argument.

---

### S-07 — Coach `<CoachInput>` `inputId` prop is never overridden

**File**: `src/components/insights/coach-panel/coach-input.tsx:45-55`
**Why**: `inputId?: string` defaults to `"coach-composer-textarea"`; no caller in the codebase passes a different value. Removing the prop drops 2 lines and one `?? default` from the signature.

**Why "maybe"**: tiny. Worth folding into the same pass that touches the file; otherwise leave it.

---

### S-08 — `cloneForCheck` variable is dead in the chat POST handler

**File**: `src/app/api/insights/chat/route.ts:434-445`
**Why**: `let cloneForCheck: NextRequest | undefined = undefined;` is assigned via `request.clone() as NextRequest`, then immediately consumed by `cloneForCheck.json()` — never referenced again, never read after the `try` block. Inline the `.clone().json()` call directly.

**Before**:
```ts
let cloneForCheck: NextRequest | undefined = undefined;
let conversationId: string | undefined = undefined;
try {
  cloneForCheck = request.clone() as NextRequest;
  const body = await cloneForCheck.json();
  if (typeof body?.conversationId === "string") conversationId = body.conversationId;
} catch { /* fall through */ }
```

**After**:
```ts
let conversationId: string | undefined = undefined;
try {
  const body = await request.clone().json();
  if (typeof body?.conversationId === "string") conversationId = body.conversationId;
} catch { /* fall through */ }
```

**Why "maybe"**: the variable's only sin is verbosity; the logic is fine. Pure cosmetic gain.

---

### S-09 — `health-score-card.tsx` delta arrow chooser is three sibling `&&` blocks

**File**: `src/components/insights/health-score-card.tsx:153-171`
**Why**: Three `delta > 0`, `delta < 0`, `delta === 0` blocks each rendering a different arrow icon. A small `deltaIcon = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus` lookup keeps all three icon imports but compresses the JSX.

**Why "maybe"**: the current shape is explicit and grep-friendly. The compressed version is shorter but introduces a colour-class lookup too (`text-dracula-green` vs `text-dracula-red` vs `text-muted-foreground`). Borderline — left as a judgement call for the maintainer who actually owns the file.

---

## apply-no (rejected — explanation only, no diff)

### S-N1 — The two `pearson` implementations (`src/lib/insights/correlations.ts` and `src/lib/analytics/correlations.ts`)

The new `pearson()` in `correlations.ts` returns a tagged union with p-value + 95 % Fisher-z confidence interval; the older `pearsonCorrelation()` returns `{ r, strength, n }` with strength buckets ("stark"/"moderat"/…). Different surface, different consumers, different statistical guarantees. Merging them would force the older callers (dashboard scatter cards) to deal with the p-value contract they don't need. Keep both.

### S-N2 — `correlations.ts` per-hypothesis bodies (`correlateBpCompliance` / `correlateMoodPulse` / `correlateWeightWeekday`)

Each runner has the same `if (insufficient) return …; if (pValue ≥ 0.05) return …; build interpretation; return ok` skeleton. Tempting to extract a generic `runHypothesis()`, but the interpretation phrases are distinct, the input shapes differ, and one of three uses ANOVA not Pearson. The current shape reads top-to-bottom; a generic abstraction would obscure the conservative-phrasing rule that lives in plain English in each runner. The CLAUDE.md guidance is explicit ("the recently-introduced abstractions … give them room"). Leave as is.

### S-N3 — `recommendation` system-prompt EN/DE near-duplication (insight-generator.ts GROUND RULES 8-11)

The German prompt mirrors the English one section-for-section. A single template with placeholder slots was tempting, but the linguistic register matters in prompts (verb mood, technical vocabulary), and Marc's voice rule explicitly wants per-locale authorship not auto-translation. Keep the two prompts side-by-side; the only thing worth doing here is a periodic diff-lint to catch when one locale gets a rule the other doesn't (already covered by the i18n integrity tests).

---

## Things deliberately NOT simplified

- **`refusal.ts` injection regex bank.** Verbose by design — a flat array of regexes lets a future audit grep any single phrase. Compressing into a tree would defeat that. Security guidance in CLAUDE.md backs this.
- **`use-coach.ts` SSE parser.** The `parseSseChunk` helper is exported AND consumed by tests. The verbose state-machine shape is the test seam; don't fold it into the streaming hook.
- **`weekly-report-view.tsx` Section/BulletList helpers.** Could be inlined back, but they're called 5 times each and read clearly. Net wash.
- **`<HeroStrip>` action-button row.** The three buttons (weekly-report disabled, ask-coach conditional, regenerate conditional) look like they want a `<HeroAction>` component — but each carries unique enable/disable/title logic, and the inline JSX matches the artboard one-to-one. Extracting would make the diff harder to compare against the design.
- **`computeHealthScore` weight-redistribution loop.** The "redistribute null components proportionally" comment IS the load-bearing logic — extracting helpers further would obscure that the same iteration order anchors the formula. Leave it.

---

## Verification gates that won't break

All proposals above are behaviour-preserving:
- S-01: pure dead-parameter removal (pre-conditions unchanged at call sites).
- S-02: extracted helper byte-identical to the three current copies.
- S-03: queryKey shape `["coachConversation", null]` is structurally equivalent for cache lookup.
- S-04: hoist is referentially identical (no closures captured).
- S-05: classnames extracted; per-component i18n keys stay local.
- S-06–S-09 (maybe): each is a strict subset of the current behaviour.
