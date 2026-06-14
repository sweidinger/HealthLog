import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SheetSection, SheetSectionCount } from "../sheet-section";

describe("<SheetSection>", () => {
  it("renders the title and summary slot on the trigger row", () => {
    const html = renderToStaticMarkup(
      <SheetSection title="More tags" summary={<span>summary-badge</span>}>
        <p>section body</p>
      </SheetSection>,
    );
    expect(html).toContain("More tags");
    expect(html).toContain("summary-badge");
  });

  it("renders children inside an open section", () => {
    // Radix Collapsible omits the content subtree while collapsed, so the
    // body is asserted on an expanded section.
    const html = renderToStaticMarkup(
      <SheetSection title="More tags" defaultOpen>
        <p>section body</p>
      </SheetSection>,
    );
    expect(html).toContain("section body");
  });

  it("starts collapsed by default and open when defaultOpen", () => {
    const closed = renderToStaticMarkup(
      <SheetSection title="Factors">
        <p>x</p>
      </SheetSection>,
    );
    const open = renderToStaticMarkup(
      <SheetSection title="Factors" defaultOpen>
        <p>x</p>
      </SheetSection>,
    );
    expect(closed).toContain('data-state="closed"');
    expect(open).toContain('data-state="open"');
  });

  it("hides the leading icon from assistive tech", () => {
    const html = renderToStaticMarkup(
      <SheetSection title="Note" icon={<svg data-testid="icon" />}>
        <p>x</p>
      </SheetSection>,
    );
    expect(html).toMatch(/aria-hidden="true"[^>]*>[^<]*<svg/);
  });

  it("respects reduced motion on the content and chevron", () => {
    const html = renderToStaticMarkup(
      <SheetSection title="x">
        <p>y</p>
      </SheetSection>,
    );
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("motion-reduce:transition-none");
  });
});

describe("<SheetSectionCount>", () => {
  it("renders the count when positive", () => {
    const html = renderToStaticMarkup(<SheetSectionCount count={3} />);
    expect(html).toContain("3");
    expect(html).toContain('data-slot="sheet-section-count"');
  });

  it("renders nothing for zero or negative counts", () => {
    expect(renderToStaticMarkup(<SheetSectionCount count={0} />)).toBe("");
    expect(renderToStaticMarkup(<SheetSectionCount count={-1} />)).toBe("");
  });
});
