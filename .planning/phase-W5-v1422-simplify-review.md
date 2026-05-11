# Wave 5 — Simplify review (v1.4.22)

Reviewed: develop @ 363e73c. Scope per the brief: W2 insights surface (`hero-strip.tsx`, `daily-briefing.tsx`, `recommendation-card.tsx`, `correlation-row.tsx`, `trends-row.tsx`, `<InsightsSectionNav>` in `src/app/insights/page.tsx`), W3 coach (`coach-panel/*`, `src/lib/ai/coach/system-prompt.ts`, `src/lib/ai/coach/keyvalues.ts`), W4 surfaces (`src/app/targets/page.tsx`, `src/components/admin/api-token-overview-section.tsx`, `src/proxy.ts`, the i18n+UI sweep diffs).

## Summary

Total findings: 5 apply-yes · 4 apply-maybe · 6 apply-no

## apply-yes (clear wins)

### S-01 — Coach composer duplicates the canSubmit guard 3×

**File**: `src/components/insights/coach-panel/coach-input.tsx:66-83`
**Why**: `!disabled && value.trim().length > 0` appears in both `handleKeyDown` and `handleFormSubmit`, then is computed again as `canSubmit` for the send-button `disabled` prop. The two handlers can call `canSubmit` directly — no behaviour change, fewer places to drift.
**Before** (≤8 lines):

```
const handleKeyDown = useCallback((event) => {
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  event.preventDefault();
  if (!disabled && value.trim().length > 0) onSubmit();
}, [disabled, onSubmit, value]);
const handleFormSubmit = useCallback((event) => {
  event.preventDefault();
  if (!disabled && value.trim().length > 0) onSubmit();
}, [disabled, onSubmit, value]);
const canSubmit = !disabled && value.trim().length > 0;
```

**After** (≤8 lines):

```
const canSubmit = !disabled && value.trim().length > 0;
const handleKeyDown = useCallback((event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if (canSubmit) onSubmit();
}, [canSubmit, onSubmit]);
const handleFormSubmit = useCallback((event) => {
  event.preventDefault();
  if (canSubmit) onSubmit();
}, [canSubmit, onSubmit]);
```

### S-02 — Hero strip duplicates the entire weekly-report Button

**File**: `src/components/insights/hero-strip.tsx:241-267`
**Why**: The `weeklyReportHref ? <Button asChild …> : <Button disabled …>` ternary repeats `variant="default"`, `size="sm"`, the same `data-slot`, the same `className`, the same icon and label. Only `asChild` / `disabled` / `title` / wrapping `<Link>` differ. Collapse to one Button whose children are the icon+label, with the link wrapping conditionally.
**Before** (≤8 lines):

```
{weeklyReportHref ? (
  <Button asChild variant="default" size="sm" data-slot="…-weekly-report" className="gap-1.5">
    <Link href={weeklyReportHref}><FileText … /><span>{t(…)}</span></Link>
  </Button>
) : (
  <Button type="button" variant="default" size="sm" disabled title={comingSoon}
          data-slot="…-weekly-report" className="gap-1.5">
    <FileText … /><span>{t(…)}</span>
  </Button>
)}
```

**After** (≤8 lines):

```
const weeklyLabel = (<><FileText className="h-3.5 w-3.5" aria-hidden="true" /><span>{t("insights.heroActionWeeklyReport")}</span></>);
{weeklyReportHref ? (
  <Button asChild variant="default" size="sm" data-slot="insights-hero-strip-action-weekly-report" className="gap-1.5">
    <Link href={weeklyReportHref}>{weeklyLabel}</Link>
  </Button>
) : (
  <Button variant="default" size="sm" disabled title={comingSoon}
          data-slot="insights-hero-strip-action-weekly-report" className="gap-1.5">{weeklyLabel}</Button>
)}
```

### S-03 — API-token status badge repeated for desktop + mobile

**File**: `src/components/admin/api-token-overview-section.tsx:215-228, 281-299`
**Why**: The `revoked / isExpired / active` 3-way ternary appears twice with the same labels; the two copies only differ in `text-xs` vs `text-[10px]`. Extract a `<TokenStatusBadge size="sm" | "xs" />` helper. Removes ~20 lines and keeps the two surfaces in lock-step.
**Before** (≤8 lines):

```
{token.revoked ? (
  <Badge variant="destructive" className="text-xs">{t("settings.tokenRevoked")}</Badge>
) : isExpired ? (
  <Badge variant="destructive" className="text-xs">{t("settings.tokenExpired")}</Badge>
) : (
  <Badge className="bg-dracula-green/15 text-dracula-green text-xs">{t("common.active")}</Badge>
)}
// …same block again with text-[10px] in the mobile list
```

**After** (≤8 lines):

```
function TokenStatusBadge({ token, size }: { token: ApiTokenInfo; size: "sm" | "xs" }) {
  const { t } = useTranslations();
  const expired = token.expiresAt && new Date(token.expiresAt) < new Date();
  const cls = size === "xs" ? "text-[10px]" : "text-xs";
  if (token.revoked) return <Badge variant="destructive" className={cls}>{t("settings.tokenRevoked")}</Badge>;
  if (expired) return <Badge variant="destructive" className={cls}>{t("settings.tokenExpired")}</Badge>;
  return <Badge className={`bg-dracula-green/15 text-dracula-green ${cls}`}>{t("common.active")}</Badge>;
}
```

### S-04 — TrendsRow inlines the same dynamic-load skeleton twice

**File**: `src/components/insights/trends-row.tsx:29-53`
**Why**: Both `dynamic()` calls use an identical `loading: () => <div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />`. Hoist the skeleton to a constant. (No chart-visual change — purely the placeholder; cleared against `feedback_charts_visual_identity.md`.)
**Before** (≤8 lines):

```
const HealthChart = dynamic(() => import(…).then((mod) => ({ default: mod.HealthChart })),
  { ssr: false, loading: () => (<div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />) });
const MoodChart = dynamic(() => import(…).then((mod) => ({ default: mod.MoodChart })),
  { ssr: false, loading: () => (<div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />) });
```

**After** (≤8 lines):

```
const ChartSkeleton = () => (
  <div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />
);
const HealthChart = dynamic(() => import("@/components/charts/health-chart").then((m) => ({ default: m.HealthChart })),
  { ssr: false, loading: ChartSkeleton });
const MoodChart = dynamic(() => import("@/components/charts/mood-chart").then((m) => ({ default: m.MoodChart })),
  { ssr: false, loading: ChartSkeleton });
```

### S-05 — CorrelationRow grid className ternary duplicates the prefix

**File**: `src/components/insights/correlation-row.tsx:59-65`
**Why**: Both branches start with `"grid grid-cols-1 gap-4"`; only the `md:grid-cols-2` is conditional. `cn()` already imported by sibling components — use it here.
**Before** (≤8 lines):

```
<div
  className={
    okResults.length === 1
      ? "grid grid-cols-1 gap-4"
      : "grid grid-cols-1 gap-4 md:grid-cols-2"
  }
>
```

**After** (≤8 lines):

```
<div className={cn("grid grid-cols-1 gap-4", okResults.length > 1 && "md:grid-cols-2")}>
```

## apply-maybe (judgment calls)

### S-M1 — `daily-briefing.tsx` parallel TONE\_\* maps

**File**: `src/components/insights/daily-briefing.tsx:68-78`
**Status**: maybe. Could fold `TONE_BAR_CLASSNAME` + `TONE_TEXT_CLASSNAME` into one record-of-objects. But the current shape reads naturally and the two are looked up independently. Mild win at best; leave it unless adjacent tone work brings us back.

### S-M2 — `source-chips.tsx` builds a transient `chips` array then maps it

**File**: `src/components/insights/coach-panel/source-chips.tsx:55-72`
**Status**: maybe. Folds two `.map()`s into one. But the pre-built array gives `key={chip.key}` a stable handle and reads as "compute, then render", which the team's other chip strips follow. Skip unless we hit perf.

### S-M3 — `MessageThread` user-bubble avatar two-arm ternary

**File**: `src/components/insights/coach-panel/message-thread.tsx:194-211`
**Status**: maybe. The `gravatarUrl ? <img/> : <div/>` arms each carry the same `data-slot="coach-bubble-user-avatar"` and `mt-0.5 size-8 shrink-0 rounded-full`. A pre-computed `avatarNode` would shave ~4 lines. The eslint-disable comment for `<img>` is the only structural difference — small win, low priority.

### S-M4 — `proxy.ts` LEGACY_ADMIN_ANCHORS

**File**: `src/proxy.ts:64-78`
**Status**: maybe. 12 entries that 1:1 map `section-<slug>` → `<slug>`. Could collapse via a regex (`pathname.replace(/^\/admin\/section-/, "/admin/")` after a startsWith check) — but the explicit map is grep-able, paths like `umami` and `glitchtip` and `webpush` and `bugreport` all funnel to `/admin/integrations` so the mapping isn't a clean rename. Keep the explicit map.

## apply-no (rejected — explanation)

### S-N1 — `keyvalues.ts` parser

**Why**: Security-adjacent (input from LLM, sentinel parser). The brief excludes "sentinel parser, proxy.ts redirect" from simplification. The parser's defence-in-depth (1KB + 8-line + per-row Zod) is exactly the surface that should not get cleverer.

### S-N2 — `proxy.ts` redirect

**Why**: Excluded by the brief. The onboarding-cookie check + worker-mode 503 + LEGACY_REDIRECTS chain is the security path; reshaping it for a couple of lines is the wrong trade.

### S-N3 — `recommendation-card.tsx` `metricTypeToChartTypes` switch-ladder

**Why**: Reads as a table of metric synonyms with the deliberate "unknown → pass through verbatim" fallthrough commented in. Folding into a Map loses the comment-as-code. Keep verbatim.

### S-N4 — `targets/page.tsx` STATUS_CATEGORY_KEY

**Why**: 50-entry verbatim translation map. It IS the data; there's no helper to extract.

### S-N5 — `targets/page.tsx` Sparkline + TYPE_ICONS / TYPE_COLORS

**Why**: Newly-introduced sparkline (give the abstraction room per the brief). Parallel `TYPE_ICONS` / `TYPE_COLORS` reads cleanly and matches the rest of the app's icon-table convention.

### S-N6 — `system-prompt.ts` EN/DE blocks

**Why**: Test-fixture-equivalent prompt copy. The brief excludes test fixture data and "newly-introduced abstractions"; both apply. The two locale blocks intentionally diverge to read native in each language.

## Notes / push-back

- **`hero-strip.tsx` `resolveGreetingKey` JSDoc drift**: the JSDoc still names a 4-bucket schedule (morning / afternoon / evening / night) but the code merged night into evening per the comment below. Stale documentation — purely a doc fix, not a simplify finding.
- **`InsightsSectionNav` IntersectionObserver `observerRef`**: held in a `useRef` but only used inside the effect that creates it. A local `const observer = new IntersectionObserver(…)` plus `observer.disconnect()` in the cleanup would drop the ref entirely. Tiny readability win — call it apply-maybe-S-M5 if the lift gets re-touched.
- **No tests in scope tested the framework.** The `targets-sparkline.test.tsx` cases pin actual rendered output (data-slot presence, signed delta, locale string) — keep.
- **The W2 BP-tile "synthesised slope" `slope = (pct7 - pct30) / 30` (per A2) sits in `src/app/page.tsx`, outside the scope-listed files for W5. Skipped.**
