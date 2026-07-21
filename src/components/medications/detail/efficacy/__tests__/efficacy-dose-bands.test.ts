/**
 * Stage C.3 — per-dose-level bands on the Wirkung chart.
 *
 * Pins the pure interval math that turns dose-change markers into bands:
 *   - consecutive changes become adjacent intervals; the last runs to the
 *     chart's right edge;
 *   - a change before the visible window starts the first band at the left
 *     edge (clamp to domainMin), not off-screen;
 *   - a change beyond the right edge (a still-dataless planned step) yields
 *     no band;
 *   - input is sorted, so marker order never matters;
 *   - labels + parity index (for the alternating shading) are preserved.
 */
import { describe, expect, it } from "vitest";

import { buildDoseBands } from "../efficacy-chart";

const D = (iso: string) => Date.parse(iso);

const MIN = D("2026-05-01T00:00:00Z");
const RIGHT = D("2026-06-01T00:00:00Z");

describe("buildDoseBands", () => {
  it("turns consecutive changes into adjacent bands, last to the right edge", () => {
    const bands = buildDoseBands(
      [
        { at: "2026-05-01T00:00:00Z", label: "30 mg" },
        { at: "2026-05-10T00:00:00Z", label: "50 mg" },
        { at: "2026-05-20T00:00:00Z", label: "70 mg" },
      ],
      MIN,
      RIGHT,
    );
    expect(bands).toEqual([
      { x1: MIN, x2: D("2026-05-10T00:00:00Z"), label: "30 mg", index: 0 },
      {
        x1: D("2026-05-10T00:00:00Z"),
        x2: D("2026-05-20T00:00:00Z"),
        label: "50 mg",
        index: 1,
      },
      { x1: D("2026-05-20T00:00:00Z"), x2: RIGHT, label: "70 mg", index: 2 },
    ]);
  });

  it("clamps a pre-window change to the left edge", () => {
    const min = D("2026-05-05T00:00:00Z");
    const bands = buildDoseBands(
      [
        { at: "2026-05-01T00:00:00Z", label: "30 mg" },
        { at: "2026-05-10T00:00:00Z", label: "50 mg" },
      ],
      min,
      RIGHT,
    );
    expect(bands[0].x1).toBe(min);
    expect(bands[0].x2).toBe(D("2026-05-10T00:00:00Z"));
    expect(bands[1].x2).toBe(RIGHT);
  });

  it("drops a change beyond the right edge (dataless planned step)", () => {
    const right = D("2026-05-15T00:00:00Z");
    const bands = buildDoseBands(
      [
        { at: "2026-05-10T00:00:00Z", label: "50 mg" },
        { at: "2026-05-20T00:00:00Z", label: "70 mg" },
      ],
      MIN,
      right,
    );
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({
      x1: D("2026-05-10T00:00:00Z"),
      x2: right,
      label: "50 mg",
      index: 0,
    });
  });

  it("sorts unordered markers", () => {
    const bands = buildDoseBands(
      [
        { at: "2026-05-10T00:00:00Z", label: "50 mg" },
        { at: "2026-05-01T00:00:00Z", label: "30 mg" },
      ],
      MIN,
      RIGHT,
    );
    expect(bands.map((b) => b.label)).toEqual(["30 mg", "50 mg"]);
  });

  it("returns no bands for an empty marker list", () => {
    expect(buildDoseBands([], MIN, RIGHT)).toEqual([]);
  });

  it("ignores unparseable dates", () => {
    const bands = buildDoseBands(
      [
        { at: "not-a-date", label: "??" },
        { at: "2026-05-10T00:00:00Z", label: "50 mg" },
      ],
      MIN,
      RIGHT,
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].label).toBe("50 mg");
  });
});
