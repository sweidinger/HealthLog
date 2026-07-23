/**
 * v1.32.9 (Coach Guard II / G2) — the typed Grounding Ledger.
 *
 * Two things are load-bearing here:
 *  - D9 structural completeness: every declared registration source actually
 *    contributes. A source added to `LEDGER_SOURCES` without being wired into
 *    `buildGroundingLedger` fails this test rather than silently shipping
 *    ungraded figures — the briefing "walk, don't hand-list" invariant.
 *  - D3 persistence boundary: only tool-trace / inventory / workout / snapshot
 *    figures are persisted for cross-turn recall; the cross-turn, memory,
 *    schedule, reference, and guided sources are NOT re-persisted (and assistant
 *    prose is never a source at all).
 */
import { describe, expect, it } from "vitest";

import {
  buildGroundingLedger,
  figuresForPersistence,
  LEDGER_SOURCES,
} from "@/lib/ai/coach/grounding-ledger";
import type { LedgerSource } from "@/lib/ai/coach/coach-prose-grounding";

/**
 * One numeric fixture per source, chosen so every sentinel is distinct — the
 * completeness assertion can then attribute each magnitude to exactly one
 * source. This IS the D9 fixture: render every prompt-contributing module with
 * numbers and assert each lands in the ledger under its own source tag.
 */
const SENTINEL: Record<LedgerSource, { input: object; value: number }> = {
  "tool:this-turn": {
    input: { toolPayloads: [{ aggregate: { mean: 128 } }] },
    value: 128,
  },
  inventory: { input: { inventoryEntries: [{ count: 42 }] }, value: 42 },
  "workout-evidence": {
    input: { workoutEvidence: { totalEnergyKcal: 411 } },
    value: 411,
  },
  snapshot: {
    input: { snapshotSections: { bp: { aggregate: { mean: 118 } } } },
    value: 118,
  },
  "transcript:tool-trace": {
    input: { priorToolFigures: [95] },
    value: 95,
  },
  "transcript:user": {
    input: { priorUserMessages: ["I weighed 77 kg this morning."] },
    value: 77,
  },
  memory: { input: { memoryTexts: ["your goal of 85 kg"] }, value: 85 },
  schedule: { input: { scheduleDoses: [7.5] }, value: 7.5 },
  "reference-grounding": {
    input: { referenceGrounding: "the normal range is 63 to 99 mg/dL" },
    value: 63,
  },
  guided: {
    input: { guidedBlock: "clarifying context around 33 units" },
    value: 33,
  },
};

describe("buildGroundingLedger — D9 structural completeness", () => {
  it("declares every registration source in LEDGER_SOURCES exactly once", () => {
    expect(new Set(LEDGER_SOURCES).size).toBe(LEDGER_SOURCES.length);
    // The fixture map must cover the declared source list — adding a source
    // without a fixture (or vice-versa) breaks this.
    expect(new Set(Object.keys(SENTINEL))).toEqual(new Set(LEDGER_SOURCES));
  });

  it("registers a numeric fixture from EVERY declared source under its own tag", () => {
    // Build ONE ledger with every source populated at once, then assert each
    // source contributed its sentinel. A source dropped from the builder makes
    // its sentinel absent → this fails.
    const combined = Object.values(SENTINEL).reduce(
      (acc, { input }) => ({ ...acc, ...input }),
      {},
    );
    const ledger = buildGroundingLedger(combined);
    const emitted = new Set(ledger.map((e) => e.source));

    for (const source of LEDGER_SOURCES) {
      const { value } = SENTINEL[source];
      expect(emitted.has(source)).toBe(true);
      const found = ledger.some(
        (e) => e.source === source && Math.abs(e.value - value) < 1e-9,
      );
      expect(found, `source ${source} did not register ${value}`).toBe(true);
    }
  });

  it("tags a medication schedule dose with the dose kind", () => {
    const ledger = buildGroundingLedger({ scheduleDoses: [7.5] });
    const entry = ledger.find((e) => e.value === 7.5);
    expect(entry?.source).toBe("schedule");
    expect(entry?.kind).toBe("dose");
  });

  it("registers both the signed and absolute form of a text-sourced number", () => {
    // A reference band written "−1.2 to 1.2" must reconcile either narration.
    const ledger = buildGroundingLedger({
      referenceGrounding: "a delta of -1.2 kg",
    });
    const values = ledger.map((e) => e.value);
    expect(values).toContain(-1.2);
    expect(values).toContain(1.2);
  });
});

describe("figuresForPersistence — cross-turn recall boundary (D3)", () => {
  it("persists this-turn tool / inventory / workout / snapshot figures", () => {
    const ledger = buildGroundingLedger({
      toolPayloads: [{ aggregate: { mean: 128 } }],
      inventoryEntries: [{ count: 42 }],
      workoutEvidence: { totalEnergyKcal: 411 },
    });
    const figures = figuresForPersistence(ledger);
    expect(figures).toContain(128);
    expect(figures).toContain(42);
    expect(figures).toContain(411);
  });

  it("does NOT re-persist cross-turn / memory / schedule / reference / guided figures", () => {
    const ledger = buildGroundingLedger({
      priorToolFigures: [95],
      priorUserMessages: ["I weighed 77 kg"],
      memoryTexts: ["goal of 85 kg"],
      scheduleDoses: [7.5],
      referenceGrounding: "normal is 63 to 99",
      guidedBlock: "context 33",
    });
    const figures = figuresForPersistence(ledger);
    // None of these should be persisted — they are re-derived every turn from
    // their own live sources, never carried forward as "tool trace".
    for (const v of [95, 77, 85, 7.5, 63, 99, 33]) {
      expect(figures).not.toContain(v);
    }
  });
});
