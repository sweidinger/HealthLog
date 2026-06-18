/**
 * v1.18.6 — absolute clinical safety-floor engine.
 *
 * Pins each threshold + the confirm-before-alarm gate. The engine must NEVER
 * escalate on a single breach reading — a prior same-floor reading inside the
 * confirm window is required. Severe tiers keep the confirm gate; symptom
 * coupling only lifts the copy tier, never the gate.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateBloodPressure,
  evaluateGlucose,
  CONFIRM_WINDOW_MS,
  BP_SYS_HYPERTENSIVE,
  BP_DIA_HYPERTENSIVE,
  BP_SYS_HYPOTENSIVE,
  GLUCOSE_HYPO,
  GLUCOSE_HYPO_SEVERE,
  GLUCOSE_HYPER,
  type BpSample,
  type GlucoseSample,
} from "../safety-floors";

const T0 = new Date("2026-06-18T09:00:00Z");
/** A confirming prior reading 10 minutes before the candidate (in window). */
const T_PRIOR = new Date(T0.getTime() - 10 * 60 * 1000);
/** A prior reading just outside the confirm window. */
const T_STALE = new Date(T0.getTime() - CONFIRM_WINDOW_MS - 60 * 1000);

function bp(measuredAt: Date, systolic: number, diastolic: number): BpSample {
  return { measuredAt, systolic, diastolic };
}
function gl(measuredAt: Date, mgdl: number): GlucoseSample {
  return { measuredAt, mgdl };
}

describe("safety-floors — blood pressure", () => {
  it("does not escalate on a single hypertensive reading (no confirm)", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, 185, 110),
      recent: [],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("escalates a confirmed hypertensive breach (>=180 systolic) at severe tier", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, BP_SYS_HYPERTENSIVE, 100),
      recent: [bp(T_PRIOR, 182, 98)],
      symptomCoupled: false,
    });
    expect(d).not.toBeNull();
    expect(d!.reason).toBe("bp_hypertensive");
    expect(d!.tier).toBe("severe");
    expect(d!.symptomCoupled).toBe(false);
    expect(d!.value).toBe(BP_SYS_HYPERTENSIVE);
    expect(d!.diastolic).toBe(100);
  });

  it("escalates when only the diastolic crosses the floor (>=120)", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, 150, BP_DIA_HYPERTENSIVE),
      recent: [bp(T_PRIOR, 150, 122)],
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("bp_hypertensive");
  });

  it("does not confirm with a reading outside the window", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, 190, 115),
      recent: [bp(T_STALE, 190, 115)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("does not confirm with a prior reading of a DIFFERENT floor family", () => {
    // candidate hypertensive, prior hypotensive — not the same floor.
    const d = evaluateBloodPressure({
      candidate: bp(T0, 185, 110),
      recent: [bp(T_PRIOR, 85, 55)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("treats low BP (<90 systolic) as caution when asymptomatic", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, BP_SYS_HYPOTENSIVE - 1, 55),
      recent: [bp(T_PRIOR, 86, 54)],
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("bp_hypotensive");
    expect(d?.tier).toBe("caution");
  });

  it("lifts low BP to severe when symptom-coupled", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, 85, 55),
      recent: [bp(T_PRIOR, 86, 54)],
      symptomCoupled: true,
    });
    expect(d?.reason).toBe("bp_hypotensive");
    expect(d?.tier).toBe("severe");
    expect(d?.symptomCoupled).toBe(true);
  });

  it("does not escalate a normal reading", () => {
    const d = evaluateBloodPressure({
      candidate: bp(T0, 120, 78),
      recent: [bp(T_PRIOR, 122, 80)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("ignores a future-dated prior reading (after the candidate)", () => {
    const future = new Date(T0.getTime() + 5 * 60 * 1000);
    const d = evaluateBloodPressure({
      candidate: bp(T0, 185, 110),
      recent: [bp(future, 185, 110)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });
});

describe("safety-floors — glucose", () => {
  it("does not escalate a single low reading (no confirm)", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 65),
      recent: [],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("escalates a confirmed hypo (<70) at caution tier", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, GLUCOSE_HYPO - 1),
      recent: [gl(T_PRIOR, 66)],
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("glucose_hypo");
    expect(d?.tier).toBe("caution");
    expect(d?.value).toBe(GLUCOSE_HYPO - 1);
  });

  it("escalates a confirmed severe-hypo (<54) at severe tier", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, GLUCOSE_HYPO_SEVERE - 4),
      recent: [gl(T_PRIOR, 52)],
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("glucose_hypo_severe");
    expect(d?.tier).toBe("severe");
  });

  it("confirms a severe-hypo candidate with any low (<70) re-test (same floor family)", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 50),
      recent: [gl(T_PRIOR, 68)], // 68 is hypo but not severe — still confirms LOW family
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("glucose_hypo_severe");
    expect(d?.tier).toBe("severe");
  });

  it("escalates a confirmed hyper (>=250) at severe tier", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, GLUCOSE_HYPER),
      recent: [gl(T_PRIOR, 270)],
      symptomCoupled: false,
    });
    expect(d?.reason).toBe("glucose_hyper");
    expect(d?.tier).toBe("severe");
  });

  it("does NOT escalate the 200 DKA criterion (euglycemic-DKA conservatism)", () => {
    // ADA-2026 lowered the DKA criterion to >=200, but a value alone cannot
    // rule DKA in or out, so we never URGENTLY escalate at 200 — only at 250.
    const d = evaluateGlucose({
      candidate: gl(T0, 210),
      recent: [gl(T_PRIOR, 220)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("does not confirm a low candidate with a high re-test (different family)", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 60),
      recent: [gl(T_PRIOR, 260)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("does not confirm outside the window", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 50),
      recent: [gl(T_STALE, 50)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });

  it("carries the symptom flag through to the decision", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 300),
      recent: [gl(T_PRIOR, 280)],
      symptomCoupled: true,
    });
    expect(d?.symptomCoupled).toBe(true);
  });

  it("does not escalate an in-range reading", () => {
    const d = evaluateGlucose({
      candidate: gl(T0, 110),
      recent: [gl(T_PRIOR, 105)],
      symptomCoupled: false,
    });
    expect(d).toBeNull();
  });
});
