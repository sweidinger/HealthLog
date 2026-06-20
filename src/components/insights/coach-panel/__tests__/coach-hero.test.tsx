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
  it("renders the centred greeting, the composer slot, and the chips", () => {
    const html = render(
      <CoachHero
        composer={<div data-slot="test-composer">composer</div>}
        prompts={["What should I tell my doctor?", "Is my medication working?"]}
        onPickPrompt={() => {}}
      />,
    );
    expect(html).toContain('data-slot="coach-hero"');
    // Greeting copy from insights.coach.heroGreeting.
    expect(html).toContain("How can I help you?");
    // The composer is re-parented into the hero, not forked.
    expect(html).toContain('data-slot="coach-hero-composer"');
    expect(html).toContain('data-slot="test-composer"');
    // Both starter-question chips render.
    const chips = (html.match(/data-slot="coach-hero-chip"/g) ?? []).length;
    expect(chips).toBe(2);
    expect(html).toContain("What should I tell my doctor?");
    expect(html).toContain("Is my medication working?");
  });

  it("renders the German greeting under the de locale", () => {
    const html = render(
      <CoachHero composer={null} prompts={[]} onPickPrompt={() => {}} />,
      "de",
    );
    expect(html).toContain("Wie kann ich dir helfen?");
  });

  it("omits the chip row when no prompts are supplied", () => {
    const html = render(
      <CoachHero composer={null} prompts={[]} onPickPrompt={() => {}} />,
    );
    expect(html).not.toContain('data-slot="coach-hero-chips"');
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
