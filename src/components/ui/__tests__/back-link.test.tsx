import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BackLink } from "../back-link";

describe("<BackLink>", () => {
  it("renders an anchor to the href carrying the label", () => {
    const html = renderToStaticMarkup(
      <BackLink href="/insights/workouts" label="Back to workouts" />,
    );
    expect(html).toContain('href="/insights/workouts"');
    expect(html).toContain("Back to workouts");
    // The decorative chevron is hidden from screen readers; the label
    // carries the meaning.
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the shared left-bleed alignment on the control", () => {
    const html = renderToStaticMarkup(
      <BackLink href="/medications" label="Back" />,
    );
    // The `-ml-2 w-fit` left-bleed is the standard back-nav placement; it
    // must survive on every adopting page.
    expect(html).toContain("-ml-2");
    expect(html).toContain("w-fit");
  });

  it("threads the optional data-slot for e2e/visual targeting", () => {
    const html = renderToStaticMarkup(
      <BackLink
        href="/insights"
        label="Back"
        dataSlot="composite-score-back"
      />,
    );
    expect(html).toContain('data-slot="composite-score-back"');
  });
});
