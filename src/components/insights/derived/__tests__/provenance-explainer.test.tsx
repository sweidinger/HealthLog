import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProvenanceExplainer } from "../provenance-explainer";
import { I18nProvider } from "@/lib/i18n/context";
import type { DerivedProvenance } from "@/lib/insights/derived/types";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const PROVENANCE: DerivedProvenance = {
  inputs: ["WEIGHT", "HEIGHT"],
  source: "DAY",
  windowDays: 30,
  computedAt: "2026-06-02T08:00:00+02:00",
};

const EMPTY_PROVENANCE: DerivedProvenance = {
  inputs: [],
  source: "none",
  windowDays: 0,
  computedAt: "not-a-date",
};

describe("<ProvenanceExplainer>", () => {
  it("renders the method inline as a muted caption (no trigger glyph)", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={PROVENANCE}
        method="BMI is weight divided by height squared."
        bodyId="prov-1"
      />,
    );
    expect(html).toContain('data-slot="provenance-explainer-method"');
    expect(html).toContain("BMI is weight divided by height squared.");
    expect(html).toContain('id="prov-1"');
    // The old icon-only disclosure trigger is gone.
    expect(html).not.toContain('data-slot="provenance-explainer-trigger"');
  });

  it("renders the empty-inputs / bad-date provenance without throwing", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={EMPTY_PROVENANCE}
        method="method copy"
      />,
    );
    expect(html).toContain('data-slot="provenance-explainer-method"');
  });

  it("accepts a cited standard prop without erroring", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={PROVENANCE}
        method="method copy"
        standard={{
          name: "WHO BMI classification",
          url: "https://www.who.int/health-topics/obesity",
        }}
      />,
    );
    expect(html).toContain('data-slot="provenance-explainer-method"');
  });
});
