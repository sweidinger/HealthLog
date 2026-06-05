import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ScoreRing } from "../score-ring";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ScoreRing>", () => {
  it("renders the root data-slot with a band derived from the score (populated, good)", () => {
    const html = render(<ScoreRing score={82} label="/100" />);
    expect(html).toContain('data-slot="score-ring"');
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
  });

  it("derives a yellow band for a mid score", () => {
    const html = render(<ScoreRing score={55} />);
    expect(html).toContain('data-band="yellow"');
  });

  it("derives a red band for a low score", () => {
    const html = render(<ScoreRing score={20} />);
    expect(html).toContain('data-band="red"');
  });

  it("honours an explicit band override", () => {
    const html = render(<ScoreRing score={20} band="green" />);
    expect(html).toContain('data-band="green"');
  });

  it("renders the provisional/empty state for a null score", () => {
    const html = render(<ScoreRing score={null} />);
    expect(html).toContain('data-provisional="true"');
    expect(html).toContain('data-band="none"');
    expect(html).toContain('data-slot="score-ring-provisional"');
  });

  it("carries an aria-label restating the number (not colour-only)", () => {
    const html = render(<ScoreRing score={74} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
    expect(html).toContain("74");
  });

  it("carries a provisional aria-label when no score is available", () => {
    const html = render(<ScoreRing score={null} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
  });

  it("keeps the band semantic on the white-arc onGradient variant", () => {
    // The white arc drops the band colour, so the band must still ride the
    // data attribute + aria-label for the colour-blind/non-visual read.
    const html = render(
      <ScoreRing score={82} variant="onGradient" label="/100" />,
    );
    expect(html).toContain('data-band="green"');
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
  });
});
