import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodDiscoveredRelations,
  moodPairsOf,
  type DiscoveredCorrelation,
} from "../mood-discovered-relations";

/**
 * v1.12.7 — the discovered-relations surface is now a header-less pure
 * renderer embedded inside the merged "What stands out" card. The card owns
 * the correlation-discovery fetch and passes in the mood pairs; this test
 * exercises the renderer directly with `moodPairsOf` doing the mood filtering
 * the card performs.
 */

function renderWith(
  discovered: DiscoveredCorrelation[],
  pairsTested = discovered.length,
) {
  const pairs = moodPairsOf(discovered);
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodDiscoveredRelations pairs={pairs} pairsTested={pairsTested} />
    </I18nProvider>,
  );
}

function pair(over: Partial<DiscoveredCorrelation>): DiscoveredCorrelation {
  return {
    behaviour: "TIME_IN_DAYLIGHT",
    outcome: "MOOD",
    n: 40,
    r: 0.5,
    pValue: 0.001,
    qValue: 0.02,
    interpretation: "",
    lagDays: 1,
    ...over,
  };
}

describe("<MoodDiscoveredRelations>", () => {
  it("renders nothing with no pairs", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoodDiscoveredRelations pairs={[]} pairsTested={0} />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("renders nothing when no discovered pair involves mood", () => {
    const html = renderWith([
      pair({ behaviour: "ACTIVITY_STEPS", outcome: "SLEEP_DURATION" }),
    ]);
    expect(html).toBe("");
  });

  it("phrases a behaviour → next-day mood pair (mood as outcome)", () => {
    const html = renderWith([
      pair({ behaviour: "TIME_IN_DAYLIGHT", outcome: "MOOD", r: 0.5 }),
    ]);
    expect(html).toContain('data-slot="mood-discovered-relations"');
    expect(html).toContain('data-mood-role="outcome"');
    expect(html).toContain('data-direction="up"');
    // factor label resolves to the localized measurement name
    expect(html).toContain("Time in Daylight");
    expect(html).toContain("higher next-day mood");
    // The n/r/q detail rides a focusable explainer icon (its tooltip content
    // is portalled on open, so it is absent from the static markup). Assert
    // the icon is wired per pair instead of the inline stat string.
    expect(html).toContain('aria-label="How this was computed"');
  });

  it("phrases a mood → next-day outcome pair", () => {
    const html = renderWith([
      pair({ behaviour: "MOOD", outcome: "SLEEP_DURATION", r: -0.4 }),
    ]);
    expect(html).toContain('data-mood-role="behaviour"');
    expect(html).toContain('data-direction="down"');
    expect(html).toContain("Sleep");
    expect(html).toContain("lower next-day");
  });

  it("filters to mood pairs and folds the full-family caveat into the subsection explainer", () => {
    const html = renderWith(
      [
        pair({ behaviour: "TIME_IN_DAYLIGHT", outcome: "MOOD" }),
        pair({ behaviour: "ACTIVITY_STEPS", outcome: "WEIGHT" }), // non-mood
      ],
      12,
    );
    expect((html.match(/data-slot="mood-discovered-pair"/g) ?? []).length).toBe(
      1,
    );
    // The false-discovery footer + the observational disclaimer fold into the
    // subsection explainer icon; its tooltip content is portalled on open, so
    // assert the trigger exists rather than the (now hidden) footer string.
    expect(
      (html.match(/aria-label="How this was computed"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    // The former muted explainer paragraph + inline footnote rows are gone.
    expect(html).not.toContain("day-to-day pairs tested");
    expect(html).not.toContain("hold up after correcting");
  });
});
