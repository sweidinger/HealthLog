import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachHero } from "../coach-hero";
import { splitProseSegments } from "../streamed-prose";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CoachHero>", () => {
  it("renders the centred greeting and the composer slot", () => {
    const html = render(
      <CoachHero composer={<div data-slot="test-composer">composer</div>} />,
    );
    expect(html).toContain('data-slot="coach-hero"');
    // Greeting copy from insights.coach.heroGreeting — one line now.
    expect(html).toContain("Ask me anything about your data");
    // The earlier two-line subline was dropped.
    expect(html).not.toContain("Ask about your trends, medications");
    // The composer is re-parented into the hero, not forked.
    expect(html).toContain('data-slot="coach-hero-composer"');
    expect(html).toContain('data-slot="test-composer"');
  });

  it("renders the German greeting under the de locale", () => {
    const html = render(<CoachHero composer={null} />, "de");
    expect(html).toContain("Frage mich etwas zu deinen Daten");
  });

  it("does not render starter-question suggestion chips", () => {
    // v1.18.10 (W4) — the two starter chips below the composer were
    // removed; the hero is greeting + composer only.
    const html = render(<CoachHero composer={null} />);
    expect(html).not.toContain('data-slot="coach-hero-chips"');
    expect(html).not.toContain('data-slot="coach-hero-chip"');
  });
});

describe("splitProseSegments", () => {
  it("splits prose into word+trailing-space segments", () => {
    expect(splitProseSegments("Looking at your data")).toEqual([
      "Looking ",
      "at ",
      "your ",
      "data",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitProseSegments("")).toEqual([]);
  });

  it("keeps a single whitespace-free token intact", () => {
    expect(splitProseSegments("Drafting…")).toEqual(["Drafting…"]);
  });
});
