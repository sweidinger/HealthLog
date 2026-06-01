import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodNarrativeFeed,
  type MoodNarrativeItem,
} from "../mood-narrative-feed";
import { MoodInTargetTile } from "../mood-in-target-tile";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<MoodNarrativeFeed>", () => {
  it("renders nothing for an empty feed (no platitude placeholders)", () => {
    expect(render(<MoodNarrativeFeed items={[]} />)).toBe("");
  });

  it("resolves the weekday key inside the sentence", () => {
    const items: MoodNarrativeItem[] = [
      {
        kind: "weekday-dip",
        messageKey: "insights.mood.narrative.weekdayDip",
        vars: { weekdayKey: "charts.weekdaysFull.mon", delta: "0.8" },
      },
    ];
    const html = render(<MoodNarrativeFeed items={items} />);
    expect(html).toContain("Monday");
    expect(html).toContain("0.8");
    expect(html).toContain("dips most");
    expect(html).toContain('data-slot="mood-narrative-feed"');
  });

  it("resolves a structured tag key into the sentence", () => {
    const items: MoodNarrativeItem[] = [
      {
        kind: "tag-lift",
        messageKey: "insights.mood.narrative.tagLift",
        vars: { tagKey: "charts.weekdaysFull.fri", delta: "0.6" },
      },
    ];
    // `charts.weekdaysFull.fri` stands in for a catalog label key — the
    // renderer must resolve `tagKey` the same way it resolves `weekdayKey`.
    const html = render(<MoodNarrativeFeed items={items} />);
    expect(html).toContain("Friday");
    expect(html).not.toContain("charts.weekdaysFull.fri");
    expect(html).toContain("0.6");
  });

  it("renders one row per takeaway in order", () => {
    const items: MoodNarrativeItem[] = [
      {
        kind: "in-target",
        messageKey: "insights.mood.narrative.inTarget",
        vars: { pct: "72" },
      },
      {
        kind: "streak",
        messageKey: "insights.mood.narrative.streak",
        vars: { days: "5" },
      },
    ];
    const html = render(<MoodNarrativeFeed items={items} />);
    expect((html.match(/<li/g) ?? []).length).toBe(2);
    expect(html).toContain("72%");
    expect(html).toContain("5 days in a row");
  });
});

describe("<MoodInTargetTile>", () => {
  it("renders nothing when the percentage is unavailable", () => {
    expect(render(<MoodInTargetTile pct={null} />)).toBe("");
  });

  it("shows the rounded in-target percentage", () => {
    const html = render(<MoodInTargetTile pct={71.6} />);
    expect(html).toContain("72%");
    expect(html).toContain("good-mood range");
  });
});
