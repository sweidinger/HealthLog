import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SheetHeader } from "../sheet";

/**
 * The raw `SheetHeader` reserves a trailing gutter for the sheet's absolute
 * close-X the way `DialogHeader` (pr-9) does — sized to the sheet close
 * button (`right-4`, min-w-9…11) so a long raw-`<Sheet>` title never slides
 * under the X. Latent hardening (every current consumer passes its own
 * header/close), but it forecloses the Documents-class overlap at the
 * primitive. Consumers that render no close-X drop the reserve via className,
 * and tailwind-merge keeps the later value.
 */
describe("<SheetHeader>", () => {
  it("reserves the trailing close-X gutter (pr-12) by default", () => {
    const html = renderToStaticMarkup(<SheetHeader>Title</SheetHeader>);
    expect(html).toContain('data-slot="sheet-header"');
    expect(html).toContain("pr-12");
  });

  it("lets a consumer className override the reserve", () => {
    const html = renderToStaticMarkup(
      <SheetHeader className="p-3">Title</SheetHeader>,
    );
    // A later padding utility from the consumer wins under tailwind-merge.
    expect(html).toContain("p-3");
    expect(html).not.toMatch(/class="[^"]*\bpr-12\b/);
  });
});
