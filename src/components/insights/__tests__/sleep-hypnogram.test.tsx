import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import {
  SleepHypnogram,
  type SleepHypnogramSession,
} from "../sleep-hypnogram";

/**
 * v1.16.8 — hypnogram polish: the night's measuring source rides the
 * header as a muted caption, and the depth lanes derive from the stages
 * actually present in the night's spans (in `LANE_ORDER` order) instead
 * of always painting all six — an Apple night (AWAKE/REM/CORE/DEEP)
 * used to carry two permanently empty rows.
 *
 * Project convention: SSR-only tests. Recharts' `ResponsiveContainer`
 * paints nothing without measured dimensions, so the lane derivation is
 * pinned structurally against the source.
 */

const baseSession: SleepHypnogramSession = {
  night: "2026-06-09",
  source: "Apple Health",
  start: "2026-06-08T22:30:00.000Z",
  end: "2026-06-09T06:00:00.000Z",
  asleepMinutes: 420,
  inBedMinutes: 450,
  awakeMinutes: 30,
  awakenings: 2,
  stages: { DEEP: 90, REM: 100, CORE: 230, AWAKE: 30 },
  segments: [
    {
      stage: "AWAKE",
      start: "2026-06-08T22:30:00.000Z",
      end: "2026-06-08T22:45:00.000Z",
      minutes: 15,
    },
    {
      stage: "CORE",
      start: "2026-06-08T22:45:00.000Z",
      end: "2026-06-09T01:00:00.000Z",
      minutes: 135,
    },
    {
      stage: "DEEP",
      start: "2026-06-09T01:00:00.000Z",
      end: "2026-06-09T02:30:00.000Z",
      minutes: 90,
    },
  ],
};

function render(session: SleepHypnogramSession, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SleepHypnogram session={session} />
    </I18nProvider>,
  );
}

describe("<SleepHypnogram> — source caption", () => {
  it("surfaces the night's measuring source as a muted header caption", () => {
    const html = render(baseSession);
    expect(html).toContain('data-slot="sleep-hypnogram-source"');
    expect(html).toContain("Source: Apple Health");
  });

  it("localises the caption label", () => {
    const html = render(baseSession, "de");
    expect(html).toContain("Quelle: Apple Health");
  });

  it("omits the caption when the session carries no source", () => {
    const html = render({ ...baseSession, source: null });
    expect(html).not.toContain('data-slot="sleep-hypnogram-source"');
  });
});

describe("<SleepHypnogram> — lane derivation", () => {
  it("derives the Y lanes from the stages present in the spans", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/insights/sleep-hypnogram.tsx"),
      "utf8",
    );
    // Lanes come from the present stages, preserving LANE_ORDER…
    expect(src).toContain("LANE_ORDER.filter((stage) => present.has(stage))");
    // …and the axis reads the derived lane list, not the full constant.
    expect(src).toContain("domain={[-0.5, lanes.length - 0.5]}");
    expect(src).toContain("ticks={lanes.map((_, i) => lanes.length - 1 - i)}");
  });
});

describe("<SleepHypnogram> — timeline bar visibility", () => {
  const sharedEnd = "2026-06-09T06:00:00.000Z";

  it("draws the timeline bar for a multi-stage night whose segments share a right edge", () => {
    // Distinct STARTS but a shared END instant — the shape a summary-derived
    // writer reconstructs to. The earlier end-instant guard hid the bar here;
    // gating on the start instant restores it. (Regression: bar vanished,
    // leaving only the breakdown numbers.)
    const session: SleepHypnogramSession = {
      ...baseSession,
      segments: [
        {
          stage: "CORE",
          start: "2026-06-08T22:30:00.000Z",
          end: sharedEnd,
          minutes: 200,
        },
        {
          stage: "DEEP",
          start: "2026-06-09T01:00:00.000Z",
          end: sharedEnd,
          minutes: 100,
        },
        {
          stage: "REM",
          start: "2026-06-09T03:00:00.000Z",
          end: sharedEnd,
          minutes: 120,
        },
      ],
    };
    expect(render(session)).toContain('role="img"');
  });

  it("collapses to the breakdown footer for a degenerate single-instant session", () => {
    // Every segment stamped on ONE instant — no real timeline, so only the
    // breakdown footer, no bar.
    const instant = "2026-06-09T06:00:00.000Z";
    const session: SleepHypnogramSession = {
      ...baseSession,
      segments: [
        { stage: "CORE", start: instant, end: instant, minutes: 200 },
        { stage: "DEEP", start: instant, end: instant, minutes: 100 },
      ],
    };
    const html = render(session);
    expect(html).not.toContain('role="img"');
    expect(html).toContain('data-slot="sleep-hypnogram-breakdown"');
  });
});
