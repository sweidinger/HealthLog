import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SampleBriefingCard } from "../sample-briefing-card";

/**
 * The onboarding "aha" artifact must be a STATIC, clearly-labelled example
 * with zero egress: no provider is configured when it renders, so it can
 * never make a model call. These tests pin both properties — the "Example"
 * tag is present (so it's never mistaken for real data) and nothing on the
 * component touches the network.
 */

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<SampleBriefingCard>", () => {
  it("renders the sample briefing with an explicit Example tag", () => {
    const html = render(<SampleBriefingCard />);
    expect(html).toContain("Example");
    // The worked-example numbers are fixed copy, never derived from a user.
    expect(html).toContain("1.2 kg");
    expect(html).toContain('data-slot="sample-briefing-tag"');
    // The caption states plainly that this is not the user's data.
    expect(html).toContain("not your own data");
  });

  it("makes no network call — no provider exists yet, zero egress", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<SampleBriefingCard />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
