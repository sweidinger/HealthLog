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

  it("no longer paints the round `?` explainer trigger next to the heading", () => {
    const html = render(
      <SubPageShell title="Blood pressure" explainerMetric="bloodPressure">
        <span />
      </SubPageShell>,
    );
    // v1.8.6 — the `?` popover affordance was dropped; only the inline
    // definition caption remains.
    expect(html).not.toMatch(/data-slot="metric-explainer-trigger"/);
  });

  it("renders the diversity nudge node inside the heading row", () => {
    const html = render(
      <SubPageShell
        title="Weight"
        diversityNudge={<span data-slot="diversity-probe" />}
      >
        <span />
      </SubPageShell>,
    );
    // v1.8.6 — the nudge moved up to the heading row (a `Lightbulb`
    // glyph), no longer an inline block beneath the stat strip.
    const headerEnd = html.indexOf("</header>");
    const probeIdx = html.indexOf('data-slot="diversity-probe"');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(headerEnd);
  });

  it("renders the back link above the heading when supplied", () => {
    const html = render(
      <SubPageShell
        title="Weight"
        backLink={<a data-slot="back-probe">back</a>}
      >
        <span />
      </SubPageShell>,
    );
    // v1.8.7.1 — the back-nav leads the page, above the heading.
    const backIdx = html.indexOf('data-slot="back-probe"');
    const headerIdx = html.indexOf("<header");
    expect(backIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeGreaterThan(-1);
    expect(backIdx).toBeLessThan(headerIdx);
  });

  it("mounts no coach launch surface when coachLaunch is omitted", () => {
    const html = render(
      <SubPageShell title="Pulse">
        <span />
      </SubPageShell>,
    );
    // The coach icon only renders under the launch provider + flags; the
    // shell renders nothing for it on the default path.
    expect(html).not.toContain('data-slot="coach-launch-icon"');
  });
});
