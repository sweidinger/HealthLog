import { describe, it, expect } from "vitest";
import {
  getNoKeyBloodPressureStatusText,
  getNoKeyWeightStatusText,
  getNoKeyPulseStatusText,
  getNoKeyMoodStatusText,
  getNoKeyMedicationComplianceStatusText,
  getNoKeyMetricStatusText,
  getNoKeyGeneralStatusText,
} from "@/lib/insights/no-key-fallbacks";
import type { MetricSignal } from "@/lib/insights/metric-signal";

/** A minimal signal with the fields the grounded composer reads. */
function signal(overrides: Partial<MetricSignal>): MetricSignal {
  return {
    metric: "your metric",
    current: 70,
    currentWindowDays: 7,
    baseline: 65,
    delta: 5,
    deltaPct: 7.7,
    spread: 2,
    outsideNormalSwing: true,
    direction: "lower-better",
    n: 14,
    newestDaysAgo: 0,
    ...overrides,
  };
}

describe("signal-grounded no-key fallbacks", () => {
  it("names the user's value and places it against their own baseline (pulse, en)", () => {
    const text = getNoKeyPulseStatusText(
      "en",
      signal({ current: 72, baseline: 64, delta: 8, outsideNormalSwing: true }),
    );
    // Names the actual value with the metric's unit.
    expect(text).toContain("72 bpm");
    // Places it against the user's OWN baseline, not a population norm.
    expect(text).toContain("64 bpm");
    expect(text.toLowerCase()).toContain("usual average");
    // Ends with one grounded pointer (an actionable close, not a platitude).
    expect(text.trim().endsWith(".")).toBe(true);
    expect(text.toLowerCase()).toContain("same time of day");
    // No banned generic clinical opener.
    expect(text).not.toContain("Measure resting pulse in a relaxed state");
  });

  it("affirms 'nothing to act on' when the value sits inside the usual swing (weight, en)", () => {
    const text = getNoKeyWeightStatusText(
      "en",
      signal({
        metric: "weight",
        current: 80.4,
        baseline: 80.3,
        delta: 0.1,
        outsideNormalSwing: false,
        direction: "target-band",
      }),
    );
    expect(text).toContain("80.4");
    expect(text.toLowerCase()).toContain("nothing you need to act on");
  });

  it("names the value without inventing a comparison when there is no baseline (bp, de)", () => {
    const text = getNoKeyBloodPressureStatusText(
      "de",
      signal({
        metric: "blood pressure",
        current: 128,
        baseline: null,
        delta: null,
        outsideNormalSwing: null,
        deltaPct: null,
        spread: null,
      }),
    );
    expect(text).toContain("128");
    // No fabricated baseline phrasing.
    expect(text).not.toContain("Schnitt von");
  });

  it("falls back to the no-signal floor when no signal is given (mood, en)", () => {
    const text = getNoKeyMoodStatusText("en");
    // The floor states the absence plainly before saying anything else — it
    // has no signal to ground against, so it may not imply a read.
    expect(text).toContain("No assessment on this one right now");
    expect(text).toContain("Mood reads over weeks");
  });

  it("falls back to the generic tip when the signal has no finite current (adherence, en)", () => {
    const text = getNoKeyMedicationComplianceStatusText(
      "en",
      signal({ current: Number.NaN }),
    );
    expect(text).toContain("No assessment on this one right now");
    expect(text).toContain("Adherence reads as consistency over weeks");
  });

  it("adherence grounds with a percent value and a routine pointer (en)", () => {
    const text = getNoKeyMedicationComplianceStatusText(
      "en",
      signal({
        metric: "adherence",
        current: 72,
        baseline: 88,
        delta: -16,
        outsideNormalSwing: true,
        direction: "higher-better",
      }),
    );
    expect(text).toContain("72%");
    expect(text).toContain("88%");
    expect(text.toLowerCase()).toContain("reminder");
  });

  it("the generic per-metric fallback grounds against the signal's own label + unit (en)", () => {
    const text = getNoKeyMetricStatusText(
      "en",
      signal({
        metric: "your steps",
        unit: "steps",
        current: 4200,
        baseline: 7800,
        delta: -3600,
        outsideNormalSwing: true,
        direction: "higher-better",
      }),
    );
    expect(text).toContain("4200 steps");
    expect(text).toContain("7800 steps");
    expect(text.toLowerCase()).toContain("your steps");
  });

  it("the generic per-metric fallback degrades to the general tip with no signal", () => {
    expect(getNoKeyMetricStatusText("en")).toBe(
      getNoKeyGeneralStatusText("en"),
    );
  });

  // v1.28.40 — the deterministic floor now leads verdict-first (meaning before
  // the value), matching the warm AI voice a provider user sees on the next
  // read. The value + baseline still follow, so grounding is unchanged.
  it("leads with an unfavourable-direction verdict before the value (pulse, en)", () => {
    const text = getNoKeyPulseStatusText(
      "en",
      signal({
        current: 72,
        baseline: 64,
        delta: 8,
        outsideNormalSwing: true,
        direction: "lower-better",
      }),
    );
    // Verdict-first: opens on meaning, not the number.
    expect(text.startsWith("A little off your usual lately.")).toBe(true);
    // The grounded value + baseline still follow the verdict.
    expect(text).toContain("72 bpm");
    expect(text).toContain("64 bpm");
    expect(text.toLowerCase()).toContain("usual average");
  });

  it("leads with a steady verdict when inside the usual swing (weight, en)", () => {
    const text = getNoKeyWeightStatusText(
      "en",
      signal({
        metric: "weight",
        current: 80.4,
        baseline: 80.3,
        delta: 0.1,
        outsideNormalSwing: false,
        direction: "target-band",
      }),
    );
    expect(text.startsWith("Steady and much as usual.")).toBe(true);
    expect(text).toContain("80.4");
    expect(text.toLowerCase()).toContain("nothing you need to act on");
  });

  it("leads with a favourable verdict when the move is in the good direction (de)", () => {
    const text = getNoKeyMedicationComplianceStatusText(
      "de",
      signal({
        metric: "adherence",
        current: 94,
        baseline: 80,
        delta: 14,
        outsideNormalSwing: true,
        direction: "higher-better",
      }),
    );
    expect(text.startsWith("Das geht in eine gute Richtung.")).toBe(true);
    expect(text).toContain("94%");
  });

  it("opens on the value (no verdict) when there is no usable baseline (bp, de)", () => {
    const text = getNoKeyBloodPressureStatusText(
      "de",
      signal({
        metric: "blood pressure",
        current: 128,
        baseline: null,
        delta: null,
        outsideNormalSwing: null,
        deltaPct: null,
        spread: null,
      }),
    );
    // No confident verdict without a baseline → the honest value-first opener.
    expect(text.startsWith("Dein Blutdruck liegt aktuell bei 128")).toBe(true);
    expect(text).not.toContain("Schnitt von");
  });
});
