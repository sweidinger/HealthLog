import { describe, it, expect } from "vitest";
import {
  deriveCoverage,
  buildOk,
  buildInsufficient,
  scoreToBand,
  nowProvenanceTimestamp,
} from "../coverage";
import { isDerivedOk, type Derived } from "../types";

const PROV = {
  inputs: ["RESTING_HEART_RATE"],
  source: "DAY" as const,
  windowDays: 30,
  computedAt: "2026-06-02T07:00:00+02:00",
};

describe("scoreToBand", () => {
  it("maps score ranges onto the four bands", () => {
    expect(scoreToBand(90)).toBe("high");
    expect(scoreToBand(75)).toBe("high");
    expect(scoreToBand(60)).toBe("medium");
    expect(scoreToBand(50)).toBe("medium");
    expect(scoreToBand(30)).toBe("low");
    expect(scoreToBand(25)).toBe("low");
    expect(scoreToBand(10)).toBe("draft");
  });
});

describe("deriveCoverage", () => {
  it("clamps presentInputs to requiredInputs and copies missing[]", () => {
    const missing = ["HEART_RATE_VARIABILITY"];
    const { coverage } = deriveCoverage({
      requiredInputs: 2,
      presentInputs: 5,
      historyDays: 14,
      missing,
      fullHistoryDays: 30,
    });
    expect(coverage.requiredInputs).toBe(2);
    expect(coverage.presentInputs).toBe(2);
    expect(coverage.historyDays).toBe(14);
    expect(coverage.missing).toEqual(missing);
    // defensive copy, not the same reference
    expect(coverage.missing).not.toBe(missing);
  });

  it("scores a fully-covered, full-history metric high", () => {
    const { confidence } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
      fullHistoryDays: 30,
    });
    expect(confidence.score).toBe(100);
    expect(confidence.band).toBe("high");
  });

  it("drops confidence monotonically as inputs go missing", () => {
    const full = deriveCoverage({
      requiredInputs: 4,
      presentInputs: 4,
      historyDays: 30,
      missing: [],
      fullHistoryDays: 30,
    }).confidence.score;
    const partial = deriveCoverage({
      requiredInputs: 4,
      presentInputs: 2,
      historyDays: 30,
      missing: ["a", "b"],
      fullHistoryDays: 30,
    }).confidence.score;
    const sparse = deriveCoverage({
      requiredInputs: 4,
      presentInputs: 1,
      historyDays: 30,
      missing: ["a", "b", "c"],
      fullHistoryDays: 30,
    }).confidence.score;
    expect(full).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(sparse);
  });

  it("drops confidence as history shrinks", () => {
    const long = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
      fullHistoryDays: 30,
    }).confidence.score;
    const short = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 7,
      missing: [],
      fullHistoryDays: 30,
    }).confidence.score;
    expect(long).toBeGreaterThan(short);
  });

  it("floors a present-but-sparse value at 1 rather than 0", () => {
    const { confidence } = deriveCoverage({
      requiredInputs: 100,
      presentInputs: 1,
      historyDays: 1,
      missing: [],
      fullHistoryDays: 365,
    });
    expect(confidence.score).toBeGreaterThanOrEqual(1);
  });

  it("scores zero when nothing is present", () => {
    const { confidence } = deriveCoverage({
      requiredInputs: 2,
      presentInputs: 0,
      historyDays: 0,
      missing: ["a", "b"],
    });
    expect(confidence.score).toBe(0);
    expect(confidence.band).toBe("draft");
  });
});

describe("buildOk / buildInsufficient — Derived<T> branching", () => {
  it("buildOk produces the ok arm with all four facets", () => {
    const { coverage, confidence } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
    });
    const d: Derived<{ center: number }> = buildOk({
      value: { center: 55 },
      coverage,
      confidence,
      provenance: PROV,
    });
    expect(d.status).toBe("ok");
    expect(isDerivedOk(d)).toBe(true);
    if (isDerivedOk(d)) {
      expect(d.value.center).toBe(55);
      expect(d.confidence.band).toBe("high");
      expect(d.provenance.source).toBe("DAY");
    }
  });

  it("buildInsufficient produces the gated arm with coverage + reason, no value", () => {
    const { coverage } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: ["RESTING_HEART_RATE"],
    });
    const d: Derived<{ center: number }> = buildInsufficient({
      coverage,
      provenance: { ...PROV, source: "none", windowDays: 0 },
      reason: "no_readings_in_window",
    });
    expect(d.status).toBe("insufficient");
    expect(isDerivedOk(d)).toBe(false);
    if (d.status === "insufficient") {
      expect(d.reason).toBe("no_readings_in_window");
      expect(d.coverage.missing).toContain("RESTING_HEART_RATE");
      // the gated arm carries no `value` / `confidence` keys
      expect("value" in d).toBe(false);
      expect("confidence" in d).toBe(false);
    }
  });
});

describe("nowProvenanceTimestamp", () => {
  it("emits an ISO-8601 string", () => {
    const ts = nowProvenanceTimestamp(new Date("2026-06-02T05:00:00Z"));
    expect(ts).toBe("2026-06-02T05:00:00.000Z");
  });
});
