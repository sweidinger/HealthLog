/**
 * v1.32.9 (Coach Guard II / G2+G3) — grading the Coach prose against the typed
 * Grounding Ledger, and the four-rung action ladder.
 *
 * Both directions, as the release mandate requires:
 *  - GROUNDED-PASSES: a prior-turn tool figure recalled this turn; a coach-memory
 *    goal number; a real medication-schedule dose; a reference/education
 *    sentence (rung 2).
 *  - FABRICATED-BLOCKS: an untyped cross-sentence fabrication is NOT waved
 *    through by rung 3 (D2/H2); a number the ledger never learned is flagged
 *    (the D3 unit half — the assistant-prose laundering repro lives in the
 *    route SSE test, where the ledger is built across turns).
 */
import { describe, expect, it } from "vitest";

import {
  findUnverifiedCoachNumbersInLedger,
  registerPayloadEntries,
  registerScalarEntries,
  registerTextEntries,
  type LedgerEntry,
} from "@/lib/ai/coach/coach-prose-grounding";

describe("findUnverifiedCoachNumbersInLedger — grounded passes", () => {
  it("passes a prior-turn tool figure recalled this turn (transcript:tool-trace)", () => {
    // Turn 1 fetched systolic 128; this turn the model recalls it while a fresh
    // tool (sleep) activated the verifier. The 128 lives in the ledger as a
    // prior tool figure — not stripped.
    const ledger: LedgerEntry[] = [
      ...registerPayloadEntries(
        { metric: "sleep", aggregate: { mean: 440 } },
        "tool:this-turn",
      ),
      ...registerScalarEntries([128], "transcript:tool-trace"),
    ];
    const prose =
      "Your sleep held around 440 minutes, and the 128 average we discussed still holds.";
    expect(findUnverifiedCoachNumbersInLedger(prose, ledger)).toEqual([]);
  });

  it("passes a coach-memory goal number (memory source)", () => {
    const ledger: LedgerEntry[] = [
      ...registerPayloadEntries(
        { aggregate: { latest: 87 } },
        "tool:this-turn",
      ),
      ...registerTextEntries("your goal of 85 kg", "memory"),
    ];
    const prose = "At 87 kg you're closing in on your goal of 85 kg.";
    expect(findUnverifiedCoachNumbersInLedger(prose, ledger)).toEqual([]);
  });

  it("passes a real medication-schedule dose (schedule source)", () => {
    const ledger: LedgerEntry[] = [
      ...registerPayloadEntries(
        { aggregate: { latest: 88 } },
        "tool:this-turn",
      ),
      ...registerScalarEntries([7.5], "schedule", "dose"),
    ];
    const prose = "You're steady at 88 kg while staying on your 7.5 mg dose.";
    expect(findUnverifiedCoachNumbersInLedger(prose, ledger)).toEqual([]);
  });

  it("exempts a reference/education sentence at rung 2 (population-norm framed)", () => {
    // The ledger is active (a fresh tool figure) but the education sentence's
    // 7–9 hours are a population norm, not a claim about this user's data.
    const ledger = registerPayloadEntries(
      { metric: "sleep", aggregate: { mean: 400 } },
      "tool:this-turn",
    );
    const prose =
      "Your sleep averaged 400 minutes. Adults generally need 7 to 9 hours a night.";
    expect(findUnverifiedCoachNumbersInLedger(prose, ledger)).toEqual([]);
  });

  it("exempts a German reference sentence (six-locale rung 2)", () => {
    const ledger = registerPayloadEntries(
      { metric: "pulse", aggregate: { mean: 62 } },
      "tool:this-turn",
    );
    const prose =
      "Dein Ruhepuls liegt bei 62. Die normale Ruheherzfrequenz liegt bei 60 bis 100.";
    expect(findUnverifiedCoachNumbersInLedger(prose, ledger, "de")).toEqual([]);
  });
});

describe("findUnverifiedCoachNumbersInLedger — fabricated blocks", () => {
  it("flags an untyped cross-sentence fabrication (rung 3 does NOT pass untyped — D2/H2)", () => {
    // avgSys30 128; the '158 spike' has no unit and no adjacent metric noun —
    // exactly the shape the naive 'health-shaped only' rung-3 would have waved
    // through. It must still be flagged.
    const ledger = registerPayloadEntries(
      { metric: "bp", aggregate: { avgSys30: 128 } },
      "tool:this-turn",
    );
    const prose =
      "Your blood pressure looks stable overall. That said, the spike to 158 last Tuesday is worth watching.";
    const findings = findUnverifiedCoachNumbersInLedger(prose, ledger);
    expect(findings.map((f) => f.value)).toContain(158);
  });

  it("flags a number the ledger never learned (assistant prose is not a source — D3 unit half)", () => {
    // The ledger is built ONLY from tool trace + user/memory/schedule — never
    // from a prior assistant reply. A figure that appears only in prior
    // narration is absent from the ledger, so restating it here is flagged.
    const ledger = registerPayloadEntries(
      { metric: "bp", aggregate: { avgSys30: 128 } },
      "tool:this-turn",
    );
    const prose = "Your systolic spike to 158 mmHg is the one to watch.";
    const findings = findUnverifiedCoachNumbersInLedger(prose, ledger);
    expect(findings.map((f) => f.value)).toContain(158);
  });

  it("still catches a genuine transcription drift (Guard I invariant holds)", () => {
    const ledger = registerPayloadEntries(
      { metric: "bp", aggregate: { avgSys30: 128 } },
      "tool:this-turn",
    );
    const findings = findUnverifiedCoachNumbersInLedger(
      "Your systolic averaged about 138 lately.",
      ledger,
    );
    expect(findings.map((f) => f.value)).toContain(138);
  });

  it("no-ops on an empty ledger (nothing shown to grade against)", () => {
    expect(
      findUnverifiedCoachNumbersInLedger("Your systolic averaged 138.", []),
    ).toEqual([]);
  });
});
