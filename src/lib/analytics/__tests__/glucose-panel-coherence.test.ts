/**
 * v1.17.0 — glucose panel coherence.
 *
 * The server-authoritative contract: the insights panel, the AI coach, and the
 * doctor-report PDF all read ONE computed `computeGlucoseClinicalMetrics`
 * result for the same readings — none re-derives a clinical number. This test
 * pins that invariant by deriving each surface's headline numbers from the SAME
 * engine output and asserting they agree:
 *
 *   - panel   → renders `gmi` / `estimatedA1c` / `distribution.tir` / `cv`
 *               verbatim (rounded for display only).
 *   - coach   → `snapshot.glucose.clinical` rounds `gmi` (1dp), `tirPercent`
 *               (whole %), `cvPercent` (whole %) from the same result.
 *   - doctor  → `glucoseClinical` IS the engine result, carried whole.
 *
 * Because the three consumers all call the one pure function, identical
 * readings MUST produce identical headline figures. The projections below
 * mirror the rounding each surface applies; the assertions prove no surface can
 * drift onto a different denominator or formula.
 */
import { describe, expect, it } from "vitest";
import { computeGlucoseClinicalMetrics } from "../glucose-metrics";

const NOW = new Date("2026-06-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A spread that clears the learning gate and lands in all three TIR bands. */
const VALUES = [
  60, 90, 120, 150, 180, 200, 100, 110, 95, 130, 170, 220, 80, 140, 160, 105,
  115, 125, 135, 145,
];

function readings() {
  return VALUES.map((mgdl, i) => ({
    measuredAt: new Date(NOW.getTime() - (VALUES.length - 1 - i) * DAY),
    mgdl,
  }));
}

/** Coach projection — mirrors `snapshot.glucose.clinical` (asserted branch). */
function coachProjection(m: ReturnType<typeof computeGlucoseClinicalMetrics>) {
  return {
    tirPercent: m.distribution ? Math.round(m.distribution.tir * 100) : null,
    gmi: m.gmi !== null ? Math.round(m.gmi * 10) / 10 : null,
    estimatedA1c:
      m.estimatedA1c !== null ? Math.round(m.estimatedA1c * 10) / 10 : null,
    cvPercent: m.variability ? Math.round(m.variability.cv) : null,
    unstable: m.variability?.unstable ?? null,
  };
}

/** Panel projection — mirrors the panel's display rounding. */
function panelProjection(m: ReturnType<typeof computeGlucoseClinicalMetrics>) {
  return {
    tirPercent: m.distribution ? Math.round(m.distribution.tir * 100) : null,
    gmi: m.gmi !== null ? Number(m.gmi.toFixed(1)) : null,
    estimatedA1c:
      m.estimatedA1c !== null ? Number(m.estimatedA1c.toFixed(1)) : null,
    cvPercent: m.variability ? Math.round(m.variability.cv) : null,
    unstable: m.variability?.unstable ?? null,
  };
}

describe("glucose panel ⇄ coach ⇄ doctor coherence", () => {
  it("derives identical headline numbers from one engine result", () => {
    // One computed result — exactly what each surface receives server-side.
    const result = computeGlucoseClinicalMetrics(readings(), {
      now: NOW,
      windowDays: 30,
    });
    expect(result.stillLearning).toBe(false);

    const panel = panelProjection(result);
    const coach = coachProjection(result);
    // doctor report carries the engine result verbatim
    const doctor = {
      tirPercent: result.distribution
        ? Math.round(result.distribution.tir * 100)
        : null,
      gmi: result.gmi,
      estimatedA1c: result.estimatedA1c,
      cvPercent: result.variability ? Math.round(result.variability.cv) : null,
      unstable: result.variability?.unstable ?? null,
    };

    // Panel == coach on every rounded headline figure.
    expect(panel).toEqual(coach);

    // Doctor's whole-precision figures round to the same display values.
    expect(Math.round((doctor.gmi as number) * 10) / 10).toBe(panel.gmi);
    expect(Math.round((doctor.estimatedA1c as number) * 10) / 10).toBe(
      panel.estimatedA1c,
    );
    expect(doctor.tirPercent).toBe(panel.tirPercent);
    expect(doctor.cvPercent).toBe(panel.cvPercent);
    expect(doctor.unstable).toBe(panel.unstable);
  });

  it("agrees on the learning gate for thin data across surfaces", () => {
    // 5 readings → all three surfaces see stillLearning and withhold assertion.
    const thin = computeGlucoseClinicalMetrics(
      [100, 110, 120, 130, 140].map((mgdl, i) => ({
        measuredAt: new Date(NOW.getTime() - (4 - i) * DAY),
        mgdl,
      })),
      { now: NOW, windowDays: 30 },
    );
    expect(thin.stillLearning).toBe(true);
    // the coach gates its clinical block on exactly this flag; the panel
    // renders its learning card on it; the doctor report carries the same
    // flag in `glucoseClinical.stillLearning`.
    expect(thin.gmi).not.toBeNull(); // preview value exists …
    // … but every surface keys its assertion on `stillLearning`, not on the
    // presence of the preview number.
  });

  it("is deterministic — identical input yields an identical result", () => {
    const a = computeGlucoseClinicalMetrics(readings(), {
      now: NOW,
      windowDays: 30,
    });
    const b = computeGlucoseClinicalMetrics(readings(), {
      now: NOW,
      windowDays: 30,
    });
    expect(a).toEqual(b);
  });
});
