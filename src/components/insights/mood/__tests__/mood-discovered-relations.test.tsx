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
    // v1.22 — the n/r/q detail no longer hides behind an "i" glyph + tooltip;
    // it reads inline as a muted caption, so the stat string is present in the
    // static markup.
    expect(html).toContain('data-slot="mood-explainer-detail"');
    expect(html).toContain("40 paired days");
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

  it("filters to mood pairs and reads the full-family caveat inline", () => {
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
    // v1.22 — the false-discovery footer + observational disclaimer no longer
    // hide behind an "i" glyph + tooltip; they read inline as a muted caption,
    // so both the caption slot and its text are present in the static markup.
    expect(
      (html.match(/data-slot="mood-explainer-detail"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    expect(html).toContain("day-to-day pairs tested");
  });
});
