import { describe, it, expect } from "vitest";

import { reconstructContiguousSleepTimeline } from "../reconstruct-timeline";

describe("reconstructContiguousSleepTimeline", () => {
  const onset = Date.parse("2026-06-09T21:00:00.000Z");
  const end = Date.parse("2026-06-10T05:00:00.000Z");

  it("lays stages contiguously from onset, each ending at its own instant", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: 30 * 60_000, stage: "DEEP", fieldTag: "sleep_deep" },
        { durationMs: 90 * 60_000, stage: "REM", fieldTag: "sleep_rem" },
      ],
      externalIdFor: (tag, i) => `night:seg:${tag}:${i}`,
    });
    const core = rows.find((r) => r.sleepStage === "CORE")!;
    const deep = rows.find((r) => r.sleepStage === "DEEP")!;
    const rem = rows.find((r) => r.sleepStage === "REM")!;
    expect(core.value).toBe(60);
    expect(core.measuredAt.getTime()).toBe(onset + 60 * 60_000);
    expect(deep.measuredAt.getTime()).toBe(onset + 90 * 60_000);
    expect(rem.measuredAt.getTime()).toBe(onset + 180 * 60_000);
    // Distinct instants → ordered hypnogram, not a shared right edge.
    expect(new Set(rows.map((r) => r.measuredAt.getTime())).size).toBe(3);
  });

  it("flags every laid segment reconstructed and keys an indexed externalId", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 15 * 60_000, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      externalIdFor: (tag, i) => `night:seg:${tag}:${i}`,
    });
    expect(rows.every((r) => r.reconstructed === true)).toBe(true);
    expect(rows[0].externalId).toBe("night:seg:sleep_awake:0");
    expect(rows[1].externalId).toBe("night:seg:sleep_core:1");
  });

  it("skips non-positive, null, undefined and non-finite durations", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 0, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: null, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: undefined, stage: "DEEP", fieldTag: "sleep_deep" },
        { durationMs: Number.NaN, stage: "REM", fieldTag: "sleep_rem" },
        { durationMs: 30 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      externalIdFor: (tag, i) => `night:seg:${tag}:${i}`,
    });
    expect(rows).toHaveLength(1);
    // The only laid stage keeps index 0 (skipped stages do not consume indices).
    expect(rows[0].externalId).toBe("night:seg:sleep_core:0");
    expect(rows[0].measuredAt.getTime()).toBe(onset + 30 * 60_000);
  });

  it("appends a single IN_BED envelope at the given END instant", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [{ durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" }],
      inBed: {
        durationMs: end - onset,
        measuredAt: new Date(end),
        fieldTag: "sleep_in_bed",
      },
      externalIdFor: (tag, i) => `night:seg:${tag}:${i}`,
    });
    const inBed = rows.find((r) => r.sleepStage === "IN_BED")!;
    expect(inBed.measuredAt.getTime()).toBe(end);
    expect(inBed.value).toBe(480); // 8 h
    // IN_BED is an envelope, not a placed segment — no reconstructed flag / id.
    expect(inBed.reconstructed).toBeUndefined();
    expect(inBed.externalId).toBeUndefined();
  });

  it("omits IN_BED when its duration is missing or non-positive", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [{ durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" }],
      inBed: { durationMs: 0, measuredAt: new Date(end), fieldTag: "sleep_in_bed" },
      externalIdFor: (tag, i) => `night:seg:${tag}:${i}`,
    });
    expect(rows.find((r) => r.sleepStage === "IN_BED")).toBeUndefined();
  });
});
