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
  it("renders an accessible trigger that controls the body (collapsed by default)", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={PROVENANCE}
        method="BMI is weight divided by height squared."
        bodyId="prov-1"
      />,
    );
    expect(html).toContain('data-slot="provenance-explainer-trigger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="prov-1"');
    expect(html).toContain("aria-label");
  });

  it("meets the 44px hit-target floor on the trigger", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={PROVENANCE}
        method="method copy"
      />,
    );
    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
  });

  it("renders the trigger for the empty-inputs / bad-date provenance without throwing", () => {
    const html = render(
      <ProvenanceExplainer
        provenance={EMPTY_PROVENANCE}
        method="method copy"
      />,
    );
    expect(html).toContain('data-slot="provenance-explainer-trigger"');
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
    expect(html).toContain('data-slot="provenance-explainer-trigger"');
  });
});
