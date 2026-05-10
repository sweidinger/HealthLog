import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.19 A3 — guards for the polish pass on `/insights` and the
 * dashboard:
 *
 *   1. The dashboard page does NOT mount `<CompareToggle />`. The
 *      comparison-baseline switch belongs on `/insights` only — the
 *      dashboard tile-strip is too tight for it (Marc 2026-05-10).
 *      The underlying `compareBaseline` value is still consumed by
 *      every dashboard chart; only the on-surface affordance is gone.
 *   2. The `/insights` page renders exactly ONE page-level refresh
 *      affordance — the hero's regenerate button. The advisor card
 *      no longer carries its own onRegenerate handler that
 *      duplicated the hero one and again surfaced "Analyse starten"
 *      in the empty-state CTA. The per-recommendation Regenerate
 *      stays — that's per-card, not page-level.
 *   3. The `/insights` page does NOT render the small BP / Weight /
 *      Pulse trend tiles — those duplicate the dashboard tile-strip.
 *   4. The `/insights` page does NOT pass the `aiOverviewTitle`
 *      ("Persönlicher Berater") subtitle into `<InsightAdvisorCard>`.
 *      The CardTitle ("KI-Gesundheitsanalyse") is sufficient framing;
 *      the second subtitle was an empty-section placeholder Marc
 *      called "Titel da aber NICHTS PASSIERT".
 *   5. The `stripChartTokens()` matcher catches lowercase + mixed-
 *      case AI-emitted tokens (`metric:blood_pressure_sweet_spot`),
 *      so the literal token text never reaches the DOM. The
 *      *render-side* parse matcher stays uppercase-only — only the
 *      *strip* is permissive.
 *
 * Lives under `src/app/__tests__` (next to quick-add-labels.test.ts)
 * because the consumers are the dashboard + insights page sources.
 */

const ROOT = join(__dirname, "../../..");
const DASHBOARD_PATH = join(ROOT, "src/app/page.tsx");
const INSIGHTS_PATH = join(ROOT, "src/app/insights/page.tsx");

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.19 A3 — dashboard polish", () => {
  it("dashboard page does NOT render <CompareToggle />", () => {
    const src = load(DASHBOARD_PATH);
    // The component import + JSX use are both gone. The toggle still
    // lives on /insights via a separate import there.
    expect(src).not.toMatch(/<CompareToggle\b/);
    expect(src).not.toMatch(
      /from\s+["']@\/components\/comparison\/compare-toggle["']/,
    );
  });

  it("dashboard page still consumes layout.comparisonBaseline (only the UI is gone)", () => {
    // Drift guard — if a future refactor accidentally drops the
    // baseline plumbing along with the toggle, every chart on the
    // dashboard would lose its comparison overlay silently. The
    // resolved layout still carries the value to each chart.
    const src = load(DASHBOARD_PATH);
    expect(src).toContain("comparisonBaseline");
    expect(src).toContain("compareBaseline");
  });
});

describe("v1.4.19 A3 — /insights polish", () => {
  it("renders exactly ONE on-surface refresh affordance at the page level", () => {
    const src = load(INSIGHTS_PATH);
    // The hero owns the page-level regenerate button (mounted via
    // `onRegenerate={advisor.regenerate}`). The advisor card no
    // longer carries its own duplicate handler.
    const regenerateProps = src.match(/onRegenerate=\{advisor\.regenerate\}/g);
    expect(regenerateProps?.length ?? 0).toBe(1);
  });

  it("does NOT render the duplicate <TrendCard> tile strip on /insights", () => {
    const src = load(INSIGHTS_PATH);
    // The /insights tile strip used the same TrendCard component the
    // dashboard does — duplicating numbers without any extra context.
    // The import being gone is the load-bearing assertion; the
    // leave-behind comment explaining the removal references
    // `<TrendCard>` in backtick-quoted prose, so we don't grep for
    // the JSX literal itself.
    expect(src).not.toContain('from "@/components/charts/trend-card"');
    // Also verify no JSX-style mount survives (`<TrendCard ` + space
    // for an attribute, or `<TrendCard\n` for a multi-line element).
    expect(src).not.toMatch(/<TrendCard[\s\n]/);
  });

  it("does NOT pass the `aiOverviewTitle` placeholder subtitle to <InsightAdvisorCard>", () => {
    const src = load(INSIGHTS_PATH);
    // The "Persönlicher Berater" / "Personal advisor" string was a
    // dead title above an empty-state body when the user had no
    // provider configured. Removed; the CardTitle inside the advisor
    // card already says "KI-Gesundheitsanalyse".
    expect(src).not.toContain('t("insights.aiOverviewTitle")');
  });

  it("does NOT contain raw `metric:<name>` template strings in static prose", () => {
    const src = load(INSIGHTS_PATH);
    // The chart-token pattern (`metric:WEIGHT`) is reserved for AI
    // prose and is stripped via `stripChartTokens()` before render.
    // The page source itself must not hand-write the token string
    // between JSX delimiters.
    expect(src).not.toMatch(/>\s*metric:[A-Za-z_]+\s*</);
  });
});

describe("v1.4.19 A3 — chart-token leak hardening", () => {
  // The visible "metric: blood_pressure_sweet" leak Marc saw at the
  // bottom of /insights was a model-emitted lowercase chart token
  // that the v1.4.16 strip regex (`/metric:[A-Z_]+/g`) didn't catch
  // because the character class only matches uppercase. The widened
  // matcher in `chart-tokens.ts` strips ANY case so the literal
  // string can no longer reach the DOM. Allowlisted *render* paths
  // remain uppercase-only — only the strip is permissive.
  it("the strip matcher catches lowercase model output", async () => {
    const { stripChartTokens } = await import("@/lib/insights/chart-tokens");
    expect(
      stripChartTokens("BP plateau metric:blood_pressure_sweet today"),
    ).toBe("BP plateau today");
  });

  it("the strip matcher catches mixed-case model output", async () => {
    const { stripChartTokens } = await import("@/lib/insights/chart-tokens");
    expect(stripChartTokens("note metric:BloodPressureSys then")).toBe(
      "note then",
    );
  });

  it("the parse matcher still returns ONLY uppercase allowlisted tokens", async () => {
    const { parseChartTokens } = await import("@/lib/insights/chart-tokens");
    // Lowercase / mixed-case tokens are stripped from prose but never
    // mounted as a chart — render path stays strict.
    expect(parseChartTokens("metric:blood_pressure_sweet")).toEqual([]);
    expect(parseChartTokens("metric:BloodPressureSys")).toEqual([]);
    expect(parseChartTokens("metric:WEIGHT")).toEqual(["metric:WEIGHT"]);
  });
});
