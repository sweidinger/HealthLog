import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SubPageShell } from "../sub-page-shell";

/**
 * v1.4.25 W4 — `<SubPageShell>` unit tests.
 *
 * The shell renders a focusable `<h1>` (for screen-reader landing on
 * tab navigation) plus an optional description and badge. SSR-rendered
 * markup is enough to assert the heading hierarchy + tabIndex contract.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<SubPageShell>", () => {
  it("renders the title as a focusable h1", () => {
    const html = render(
      <SubPageShell title="Blood pressure">
        <p>child</p>
      </SubPageShell>,
    );
    expect(html).toMatch(/<h1[^>]*id="insights-subpage-title"/);
    expect(html).toMatch(/tabindex="-1"/);
    expect(html).toContain("Blood pressure");
    expect(html).toContain("<p>child</p>");
  });

  it("renders the description paragraph when supplied", () => {
    const html = render(
      <SubPageShell title="Weight" description="One paragraph">
        <span />
      </SubPageShell>,
    );
    expect(html).toContain("One paragraph");
  });

  it("omits the description block when undefined", () => {
    const html = render(
      <SubPageShell title="Pulse">
        <span />
      </SubPageShell>,
    );
    // The shell uses a `<p>` for the description; no `<p>` appears when
    // neither a description nor an explainer metric is supplied.
    expect(html).not.toMatch(/<p[^>]*class="text-muted-foreground/);
  });

  it("renders the explainer body inline beneath the heading", () => {
    const html = render(
      <SubPageShell title="Blood pressure" explainerMetric="bloodPressure">
        <span />
      </SubPageShell>,
    );
    // The inline caption reuses the same body string the `?` popover reads.
    expect(html).toMatch(/data-slot="metric-explainer-inline"/);
    expect(html).toContain(
      "Blood pressure is the force your blood exerts on the artery walls",
    );
  });

  it("keeps the explainer trigger glyph when explainerMetric is set", () => {
    const html = render(
      <SubPageShell title="Blood pressure" explainerMetric="bloodPressure">
        <span />
      </SubPageShell>,
    );
    // The `?` glyph stays available alongside the inline caption.
    expect(html).toMatch(/data-slot="metric-explainer-trigger"/);
  });
});
