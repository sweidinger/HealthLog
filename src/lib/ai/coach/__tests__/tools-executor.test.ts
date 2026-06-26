/**
 * v1.20.0 (F1) — Coach retrieval tool executor: dispatch, grounding, and the
 * gate-preservation contract. The executor must NEVER throw and must return a
 * structured `{ present: false }` for an absent domain — the hallucination
 * audit asserts the model can always tell "no data" from "data".
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";

const buildCoachSnapshot =
  vi.fn<(userId: string, scope?: unknown) => Promise<CoachSnapshotResult>>();

vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: (userId: string, scope?: unknown) =>
    buildCoachSnapshot(userId, scope),
}));

const readCoachCorrelations = vi.fn();
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: (userId: string) => readCoachCorrelations(userId),
}));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";

function snapshot(
  sections: Record<string, unknown>,
  referenceGrounding: string | null = null,
): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: [], metrics: [] },
    referenceGrounding,
  };
}

describe("executeCoachTool", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
    readCoachCorrelations.mockReset();
  });

  it("returns the matching section for get_metric_series when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        { bloodPressure: { aggregate: { avgSys30: 128 } } },
        "REFERENCE GROUNDING\nBP systolic 128 …",
      ),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp" }),
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      metric: "bp",
      section: { aggregate: { avgSys30: 128 } },
    });
    expect(result.grounding).toContain("REFERENCE GROUNDING");
  });

  it("returns { present: false } (never throws) when the section is absent", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "hrv" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
    expect(result.data).toBeUndefined();
  });

  it("points get_metric_series(glucose) at the dedicated tool", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "glucose" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("use_get_glucose_panel");
    // Must not even read the snapshot for a wrong-tool call.
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments with a grounded miss, not a throw", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "not_a_metric" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });

  it("rejects malformed JSON arguments with a grounded miss", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: "{not json",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });

  it("rejects an unknown tool name without throwing", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "drop_table_users",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("unknown_tool");
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("degrades a snapshot-builder throw to { present: false }", async () => {
    buildCoachSnapshot.mockRejectedValue(new Error("db down"));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("retrieval_failed");
  });

  it("combines sleep nights + rhythm sections", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        sleep: { timeline: { recent: [] } },
        sleepRhythm: { sleepDebt: 120, chronotype: "intermediate" },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_sleep",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      nights: { timeline: { recent: [] } },
      rhythm: { sleepDebt: 120 },
    });
  });

  it("surfaces glp1 from weeklyContext on get_medication_compliance", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        compliance: { rate: 0.92 },
        weeklyContext: { glp1: { drug: "—", dose: "—" } },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_medication_compliance",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      compliance: { rate: 0.92 },
      glp1: { drug: "—" },
    });
  });

  it("filters labs by analyte and reports analyte_not_found", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        labs: { recent: [{ name: "LDL", value: "120" }] },
      }),
    );
    const hit = await executeCoachTool({
      userId: "u1",
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: "ldl" }),
    });
    expect(hit.present).toBe(true);
    expect(hit.data).toMatchObject({ recent: [{ name: "LDL" }] });

    const miss = await executeCoachTool({
      userId: "u1",
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: "glucose" }),
    });
    expect(miss.present).toBe(false);
    expect(miss.reason).toBe("analyte_not_found");
  });

  it("returns the workouts section for get_workouts when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ workouts: { recent: [{ sport: "RUN" }], totalInWindow: 3 } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: JSON.stringify({ window: "last30days" }),
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({ totalInWindow: 3 });
  });

  it("returns { present: false } for get_workouts when no block", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
  });

  it("returns the cycle section for get_cycle when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ cycle: { phase: "luteal", dayOfCycle: 21 } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_cycle",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({ phase: "luteal" });
  });

  it("returns { present: false } for get_cycle when cycle tracking is off", async () => {
    // A non-cycle account produces no cycle block (gated in the builder).
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_cycle",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
  });

  it("surfaces discovered drivers + coincident flag for get_correlations", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: true,
      drivers: [
        {
          behaviour: "time in daylight",
          outcome: "sleep duration",
          direction: "higher",
          lagDays: 1,
          n: 42,
          r: 0.31,
          note: "Higher time in daylight tends to go with higher next-day sleep duration in your data — a pattern worth watching, not a cause.",
        },
      ],
      coincident: {
        fired: false,
        contributing: [],
        day: "2026-06-02",
        illnessExplained: false,
      },
      pairsTested: 18,
      windowDays: 180,
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_correlations",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      drivers: [{ behaviour: "time in daylight", n: 42 }],
      pairsTested: 18,
    });
  });

  it("returns a clean { present: false } for get_correlations on no pattern", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: false,
      reason: "no_significant_pattern",
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_correlations",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_significant_pattern");
  });

  it("never passes userId as a tool argument (read from session only)", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    // A crafted argument trying to smuggle a userId must be rejected by the
    // strict schema, never forwarded to the read.
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp", userId: "victim" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });
});
