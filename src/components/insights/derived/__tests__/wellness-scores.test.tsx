import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  DerivedMetricResponse,
  DerivedBatchToken,
} from "../use-derived-metric";
import { WellnessScores } from "../wellness-scores";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<Record<string, unknown>>;

function ok(value: Record<string, unknown>): Resp {
  return {
    metric: "X",
    status: "ok",
    value,
    coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 30, missing: [] },
    confidence: { score: 90, band: "high" },
    provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "x" },
    reason: null,
  };
}

function absent(): Resp {
  return {
    metric: "X",
    status: "insufficient",
    value: null,
    coverage: { requiredInputs: 1, presentInputs: 0, historyDays: 0, missing: [] },
    confidence: null,
    provenance: { inputs: [], source: "none", windowDays: 30, computedAt: "x" },
    reason: "no_readings_in_window",
  };
}

function readFrom(map: Record<string, Resp>): <T>(
  token: DerivedBatchToken,
) => DerivedMetricResponse<T> | null {
  return <T,>(token: DerivedBatchToken) =>
    (map[token.metric] ?? absent()) as unknown as DerivedMetricResponse<T>;
}

describe("<WellnessScores>", () => {
  it("un-mounts the whole strip when no score has data", () => {
    const html = render(
      <WellnessScores read={readFrom({})} isLoading={false} />,
    );
    expect(html).toBe("");
  });

  it("renders nothing while loading (the page reserves the row)", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 80, band: "green" }) })}
        isLoading
      />,
    );
    // While loading no tiles resolve, so the strip stays un-mounted.
    expect(html).toBe("");
  });

  it("renders a ring tile with a canonical TileHeader icon + heading", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 82, band: "green" }) })}
        isLoading={false}
      />,
    );
    expect(html).toContain('data-slot="wellness-scores"');
    expect(html).toContain('data-metric="READINESS"');
    // Each tile leads with the shared TileHeader (icon + heading row), with
    // the metric name in the foreground-colour CardTitle.
    expect(html).toContain('data-slot="tile-header"');
    expect(html).toContain('data-slot="card-title"');
    expect(html).toContain("Readiness");
    // The ring carries its band on the arc + data-attribute (not the number).
    expect(html).toContain('data-band="green"');
    // The band word renders under the ring.
    expect(html).toContain('data-slot="wellness-score-band-word"');
  });

  it("renders one tile per available score and hides absent ones", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          READINESS: ok({ score: 80, band: "green" }),
          SLEEP_SCORE: ok({ score: 55, band: "yellow" }),
        })}
        isLoading={false}
      />,
    );
    expect(html).toContain('data-metric="READINESS"');
    expect(html).toContain('data-metric="SLEEP_SCORE"');
    expect(html).not.toContain('data-metric="RECOVERY_SCORE"');
    expect(html).not.toContain('data-metric="STRESS_SCORE"');
    expect(html).not.toContain('data-metric="STRAIN_SCORE"');
  });
});
