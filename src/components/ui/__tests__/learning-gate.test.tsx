import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LearningGate } from "../learning-gate";

describe("<LearningGate>", () => {
  it("renders the message in a polite live region marked as learning", () => {
    const html = renderToStaticMarkup(
      <LearningGate message="Still learning your sleep." />,
    );
    expect(html).toContain("Still learning your sleep.");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-state="learning"');
    expect(html).toContain('data-slot="learning-gate"');
  });

  it("renders an optional caveat as a secondary line", () => {
    const html = renderToStaticMarkup(
      <LearningGate
        message="Not enough data yet."
        caveat="About 5 more days needed."
      />,
    );
    expect(html).toContain("About 5 more days needed.");
    expect(html).toContain('data-slot="learning-gate-caveat"');
  });

  it("omits the caveat line when none is given", () => {
    const html = renderToStaticMarkup(<LearningGate message="Learning." />);
    expect(html).not.toContain("learning-gate-caveat");
  });

  it("supports a per-surface body slot override for existing selectors", () => {
    const html = renderToStaticMarkup(
      <LearningGate
        message="Not enough to score."
        bodySlot="score-anatomy-insufficient"
      />,
    );
    expect(html).toContain('data-slot="score-anatomy-insufficient"');
  });

  it("bordered variant adds the dashed standalone surface", () => {
    const inline = renderToStaticMarkup(<LearningGate message="x" />);
    const bordered = renderToStaticMarkup(
      <LearningGate message="x" variant="bordered" />,
    );
    expect(inline).not.toContain("border-dashed");
    expect(bordered).toContain("border-dashed");
  });
});
