import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DailyBriefing } from "@/lib/ai/schema";
import { BriefingSpotlight } from "../briefing-spotlight";

/**
 * `<BriefingSpotlight>` contract:
 *
 *   - renders nothing unless the briefing is FRESH (`ready` + not stale)
 *     and carries at least one signal or finding;
 *   - prefers `signalsOfDay`, falling back to `keyFindings`;
 *   - caps the strip at 3 rows;
 *   - every row links to `/insights` and carries the tone-keyed accent;
 *   - headlines render as plain text children (no HTML / markdown).
 */

function render(
  props: React.ComponentProps<typeof BriefingSpotlight>,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <BriefingSpotlight {...props} />
    </I18nProvider>,
  );
}

function briefing(overrides: Partial<DailyBriefing> = {}): DailyBriefing {
  return {
    paragraph: "x",
    signalsOfDay: null,
    keyFindings: [],
    ...overrides,
  };
}

describe("<BriefingSpotlight>", () => {
  it("renders nothing when no briefing is present", () => {
    expect(
      render({
        briefing: null,
        briefingState: "ready",
        briefingStale: false,
      }),
    ).toBe("");
  });

  it("renders nothing for a stale briefing", () => {
    expect(
      render({
        briefing: briefing({
          keyFindings: [
            {
              tone: "watch",
              headline: "BP creeping up",
              detail: "d",
              delta: "+6 mmHg",
              sourceWindow: "30d",
              sourceMetric: "bp",
            },
          ],
        }),
        briefingState: "ready",
        briefingStale: true,
      }),
    ).toBe("");
  });

  it("renders nothing while the briefing is still preparing", () => {
    expect(
      render({
        briefing: briefing({
          keyFindings: [
            {
              tone: "info",
              headline: "h",
              detail: "d",
              delta: null,
              sourceWindow: "30d",
              sourceMetric: "weight",
            },
          ],
        }),
        briefingState: "preparing",
        briefingStale: false,
      }),
    ).toBe("");
  });

  it("surfaces the present-focused signals and links each row to /insights", () => {
    const html = render({
      briefing: briefing({
        signalsOfDay: [
          {
            sourceMetric: "sleep",
            tone: "watch",
            headline: "Short on sleep this week",
            nudge: "Aim for an earlier night",
            delta: "-1.2 h",
          },
        ],
        keyFindings: [
          {
            tone: "good",
            headline: "should not appear when signals exist",
            detail: "d",
            delta: null,
            sourceWindow: "30d",
            sourceMetric: "bp",
          },
        ],
      }),
      briefingState: "ready",
      briefingStale: false,
    });
    expect(html).toContain('data-slot="dashboard-briefing-spotlight"');
    expect(html).toContain("Short on sleep this week");
    // The heading itself links to the briefing card anchor; the former
    // separate "view all" text link is gone.
    expect(html).toContain('href="/insights#daily-briefing"');
    expect(html).not.toContain('data-slot="dashboard-briefing-spotlight-link"');
    expect(html).toContain("-1.2 h");
    // Signals win over key findings when present.
    expect(html).not.toContain("should not appear when signals exist");
  });

  it("falls back to key findings when no signals were generated", () => {
    const html = render({
      briefing: briefing({
        signalsOfDay: [],
        keyFindings: [
          {
            tone: "watch",
            headline: "Blood pressure trending up",
            detail: "d",
            delta: "+8 mmHg",
            sourceWindow: "30d",
            sourceMetric: "bp",
          },
        ],
      }),
      briefingState: "ready",
      briefingStale: false,
    });
    expect(html).toContain("Blood pressure trending up");
  });

  it("caps the strip at three rows", () => {
    const html = render({
      briefing: briefing({
        signalsOfDay: [
          {
            sourceMetric: "bp",
            tone: "info",
            headline: "one",
            nudge: "n",
            delta: null,
          },
          {
            sourceMetric: "weight",
            tone: "info",
            headline: "two",
            nudge: "n",
            delta: null,
          },
          {
            sourceMetric: "mood",
            tone: "info",
            headline: "three",
            nudge: "n",
            delta: null,
          },
        ],
      }),
      briefingState: "ready",
      briefingStale: false,
    });
    const rows = html.match(/data-slot="dashboard-briefing-spotlight-row"/g);
    expect(rows).toHaveLength(3);
  });

  it("stacks headline over delta below sm and keeps the row at sm+", () => {
    const html = render({
      briefing: briefing({
        signalsOfDay: [
          {
            sourceMetric: "bp",
            tone: "watch",
            headline:
              "Systolischer Blutdruck deutlich unter deinem Monatsmittel gemessen",
            nudge: "n",
            delta: "−12 mmHg vs. 30-Tage-Mittel",
          },
        ],
      }),
      briefingState: "ready",
      briefingStale: false,
    });
    // Phone-first column, row restored at sm+ — a wide delta must never
    // squeeze the headline into a narrow multi-line column (or push
    // itself past the tile edge).
    expect(html).toMatch(
      /class="[^"]*flex min-w-0 flex-1 flex-col gap-1 sm:flex-row[^"]*"/,
    );
    // The delta is left-aligned content-width in the stacked state and
    // only refuses to shrink in the sm+ row.
    expect(html).toMatch(
      /data-slot="dashboard-briefing-spotlight-delta"[^>]*class="[^"]*self-start[^"]*sm:shrink-0[^"]*"/,
    );
  });
});
