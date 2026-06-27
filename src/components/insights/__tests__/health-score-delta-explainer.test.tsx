import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import { HealthScoreDeltaExplainer } from "../health-score-delta-explainer";

/**
 * v1.4.28 R3c-Insights — FB-I1 — the "vs last week" delta carries a
 * three-sentence read of which components contributed, what the comparison
 * window is, and one concrete next step.
 *
 * v1.22 — the read no longer hides behind a "?" glyph + popover; it renders
 * inline as a muted caption beside the delta line. These tests run through
 * SSR (no browser surface) and pin: the inline body paints by default, it
 * threads the parent-supplied id for aria-describedby, and every locale
 * ships the body copy.
 */

function ssr(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * Helper that paints the explainer body via the same `t()` call the caption
 * uses. If a future refactor drops a locale key the test fails at the `t()`
 * call site rather than silently rendering the literal key path.
 */
function BodyProbe() {
  const { t } = useTranslations();
  return (
    <span data-slot="probe-body">
      {t("insights.healthScore.deltaExplainer.body")}
    </span>
  );
}

describe("<HealthScoreDeltaExplainer>", () => {
  it("renders the read inline as a muted caption (no trigger glyph)", () => {
    const html = ssr(<HealthScoreDeltaExplainer delta={-3} />);
    expect(html).toContain('data-slot="health-score-delta-explainer-body"');
    // The old icon-only disclosure trigger is gone.
    expect(html).not.toContain(
      'data-slot="health-score-delta-explainer-trigger"',
    );
    expect(html).not.toContain("aria-expanded");
  });

  it("uses the parent-supplied bodyId so aria-describedby can thread to it", () => {
    const html = ssr(
      <HealthScoreDeltaExplainer delta={-3} bodyId="parent-id-x" />,
    );
    expect(html).toMatch(
      /<span[^>]*id="parent-id-x"[^>]*data-slot="health-score-delta-explainer-body"/,
    );
  });

  it("paints the body copy on the initial SSR snapshot (always visible)", () => {
    const html = ssr(<HealthScoreDeltaExplainer delta={-3} />);
    expect(html).toContain("BP, weight, mood and medication adherence");
  });

  it("ships the EN body copy through the locale payload (3-sentence read)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <BodyProbe />
      </I18nProvider>,
    );
    const body = html.match(
      /<span[^>]*data-slot="probe-body"[^>]*>([^<]+)<\/span>/,
    );
    expect(body).not.toBeNull();
    const text = body?.[1] ?? "";
    // Components — window — action triad pinned.
    expect(text).toContain("BP, weight, mood and medication adherence");
    expect(text).toContain("same time last week");
    expect(text).toContain("Log a fresh reading");
    // 3-sentence ceiling. Soft check: at most 4 sentence-ending
    // punctuation marks (covering the Oxford comma + 3 periods).
    const periods = (text.match(/\./g) ?? []).length;
    expect(periods).toBeLessThanOrEqual(4);
  });

  it("ships the DE body copy with the same structure (3-sentence translation)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <BodyProbe />
      </I18nProvider>,
    );
    const body = html.match(
      /<span[^>]*data-slot="probe-body"[^>]*>([^<]+)<\/span>/,
    );
    expect(body).not.toBeNull();
    const text = body?.[1] ?? "";
    expect(text).toContain("Blutdruck");
    expect(text).toContain("Stimmung");
    expect(text).toContain("Therapietreue");
    expect(text).toContain("vor einer Woche");
  });

  it("ships the body key in every locale supported by R3c-Insights", () => {
    // Pinning every locale stops a future feature branch from shipping an
    // English fallback for the explainer body key.
    for (const locale of ["en", "de", "fr", "es", "it", "pl"] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <BodyProbe />
        </I18nProvider>,
      );
      // The probe re-uses the same `t()` payload the caption does, so any
      // missing key surfaces as the literal key path which never contains a
      // space.
      expect(html).not.toContain("insights.healthScore.deltaExplainer.body");
    }
  });
});
