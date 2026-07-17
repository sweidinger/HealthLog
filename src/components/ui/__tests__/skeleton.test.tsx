import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Skeleton } from "../skeleton";

describe("<Skeleton>", () => {
  it("renders a presentation node so screen readers skip it", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-4 w-32" />);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("preserves caller classes alongside the shimmer animation", () => {
    const html = renderToStaticMarkup(
      <Skeleton className="h-8 rounded-full" />,
    );
    // The shimmer class drives the loading sweep; its reduced-motion
    // fallback lives in globals.css next to the keyframes.
    expect(html).toContain("skeleton-shimmer");
    // Caller's classes should survive the merge.
    expect(html).toContain("h-8");
    expect(html).toContain("rounded-full");
  });
});
