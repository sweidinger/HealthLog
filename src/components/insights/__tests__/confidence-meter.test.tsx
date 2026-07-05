import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { ConfidenceMeter } from "../confidence-meter";

/**
 * v1.4.16 phase B5d — `<ConfidenceMeter>`.
 *
 * Two variants:
 *   - `bars` (default): five vertical bars, lit count = ceil(value/20).
 *     0..20 = 1, 21..40 = 2, 41..60 = 3, 61..80 = 4, 81..100 = 5.
 *   - `ring`: SVG ring, fill proportional to value/100.
 *
 * Color bands match research §2.A "three-band visual" (extended to 4
 * for resolution under 50):
 *   - >=80 → green
 *   - 50..79 → yellow
 *   - 25..49 → orange
 *   - <25 → red, AND the meter is replaced with a "draft" pill so the
 *     UI signals "model is unsure, not asserting"
 *
 * aria-label translates correctly per locale ("Confidence: 67 of 100").
 * Mobile-friendly: meter components fit within 96 px wide.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ConfidenceMeter> bars variant (default)", () => {
  it("renders 5 lit bars at value=100", () => {
    const html = render(<ConfidenceMeter value={100} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(5);
  });

  it("renders 4 lit bars at value=80", () => {
    const html = render(<ConfidenceMeter value={80} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(4);
  });

  it("renders 3 lit bars at value=60", () => {
    const html = render(<ConfidenceMeter value={60} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(3);
  });

  it("renders 2 lit bars at value=40", () => {
    const html = render(<ConfidenceMeter value={40} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(2);
  });

  it("renders 2 lit bars at value=25 (lowest non-draft band)", () => {
    // Below 25 the meter is replaced by a draft pill. The bars-only
    // floor is therefore at 25 — and ceil(25/20) = 2.
    const html = render(<ConfidenceMeter value={25} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(2);
  });

  it("uses the success tint at value>=80", () => {
    const html = render(<ConfidenceMeter value={85} />);
    expect(html).toContain('data-confidence-band="high"');
    expect(html).toMatch(/bg-success/);
  });

  it("uses the caution tint at value 50..79", () => {
    const html = render(<ConfidenceMeter value={65} />);
    expect(html).toContain('data-confidence-band="medium"');
    expect(html).toMatch(/bg-warning/);
  });

  // Medium and low share the caution tint (coverage-meter precedent);
  // the band attribute + lit-bar count carry the distinction.
  it("uses the caution tint at value 25..49", () => {
    const html = render(<ConfidenceMeter value={35} />);
    expect(html).toContain('data-confidence-band="low"');
    expect(html).toMatch(/bg-warning/);
  });

  it("renders the 'draft' pill INSTEAD of bars when value<25", () => {
    const html = render(<ConfidenceMeter value={15} />);
    // No bars drawn at all
    expect(html).not.toMatch(/data-bar-state="lit"/);
    // Pill rendered
    expect(html).toContain('data-confidence-band="draft"');
    expect(html).toMatch(/Draft|Entwurf/);
  });

  it("the draft pill is also rendered at value=0", () => {
    const html = render(<ConfidenceMeter value={0} />);
    expect(html).toContain('data-confidence-band="draft"');
  });
});

describe("<ConfidenceMeter> ring variant", () => {
  it("renders an SVG when variant=ring", () => {
    const html = render(<ConfidenceMeter value={67} variant="ring" />);
    expect(html).toContain("<svg");
    expect(html).toContain('data-confidence-band="medium"');
  });

  it("ring variant respects the draft band below 25", () => {
    const html = render(<ConfidenceMeter value={10} variant="ring" />);
    expect(html).toContain('data-confidence-band="draft"');
    // Same draft pill rule as bars.
    expect(html).not.toContain("<svg");
  });
});

describe("<ConfidenceMeter> aria-label", () => {
  it("EN: 'Confidence: 67 of 100'", () => {
    const html = render(<ConfidenceMeter value={67} />);
    expect(html).toMatch(/aria-label="Confidence: 67 of 100"/);
  });

  it("DE: 'Vertrauen: 67 von 100'", () => {
    const html = render(<ConfidenceMeter value={67} />, "de");
    expect(html).toMatch(/aria-label="Vertrauen: 67 von 100"/);
  });

  it("draft state aria-label still announces the score (so screenreaders aren't blind to it)", () => {
    const html = render(<ConfidenceMeter value={15} />);
    expect(html).toMatch(/aria-label="Confidence: 15 of 100"/);
  });
});

describe("<ConfidenceMeter> input clamping", () => {
  it("clamps negative value to 0 (renders draft pill)", () => {
    const html = render(<ConfidenceMeter value={-5} />);
    expect(html).toContain('data-confidence-band="draft"');
  });

  it("clamps value>100 to 100 (renders 5 bars, high band)", () => {
    const html = render(<ConfidenceMeter value={250} />);
    const lit = (html.match(/data-bar-state="lit"/g) ?? []).length;
    expect(lit).toBe(5);
    expect(html).toContain('data-confidence-band="high"');
  });
});
