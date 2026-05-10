import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { TrendAnnotation } from "../trend-annotation";

/**
 * v1.4.20 phase B3 — single-sentence trend annotation under each
 * Trends-row chart.
 *
 * Tests cover:
 *   1. Rendered annotation prose (load-bearing slot for parents).
 *   2. Empty-state hint per metric (locale-aware).
 *   3. Optional confidence chip with three discrete bands.
 *   4. Locale switch between EN and DE.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TrendAnnotation>", () => {
  it("renders the annotation prose when supplied", () => {
    const html = render(
      <TrendAnnotation
        metric="bp"
        annotation="Systolic trending down — a pattern worth watching."
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation"/);
    expect(html).toContain("Systolic trending down");
  });

  it("uses the empty-state hint when annotation is null", () => {
    const html = render(<TrendAnnotation metric="bp" annotation={null} />);
    expect(html).toMatch(/data-slot="trend-annotation-empty"/);
    expect(html).toContain("Awaiting more data");
  });

  it("renders the empty hint in German when locale=de", () => {
    const html = render(<TrendAnnotation metric="weight" annotation={null} />, "de");
    expect(html).toContain("Mehr Daten");
  });

  it("renders the high-confidence chip when supplied", () => {
    const html = render(
      <TrendAnnotation
        metric="weight"
        annotation="Weight down 1.4 kg over 30 days."
        confidence="high"
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation-confidence"/);
    expect(html).toContain("High confidence");
  });

  it("renders the moderate-confidence chip", () => {
    const html = render(
      <TrendAnnotation metric="mood" annotation="Mood stable." confidence="moderate" />,
    );
    expect(html).toContain("Moderate confidence");
  });

  it("renders the low-confidence chip", () => {
    const html = render(
      <TrendAnnotation metric="mood" annotation="Mood stable." confidence="low" />,
    );
    expect(html).toContain("Low confidence");
  });

  it("does not render the chip when confidence is omitted", () => {
    const html = render(<TrendAnnotation metric="bp" annotation="x" />);
    expect(html).not.toMatch(/data-slot="trend-annotation-confidence"/);
  });

  it("tags the wrapper element with the metric for parent layouts", () => {
    const html = render(
      <TrendAnnotation metric="mood" annotation="Mood stable." />,
    );
    expect(html).toMatch(/data-metric="mood"/);
  });
});
