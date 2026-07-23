/**
 * v1.21.0 (P6 / C2-5) — post-hoc numeric verifier on Coach prose. It must flag
 * a number the model cited that no tool returned this turn (transcription
 * drift), exempt structural window/ordinal integers, and no-op when no tool
 * returned figures. Soft-strip replaces only the flagged tokens.
 *
 * v1.32.1 — closes three real-world false-positive shapes reported against
 * grounded Coach replies: a correctly-computed derived delta/average/percent
 * between two of a payload's own headline figures, a calendar-date ordinal
 * ("July 21st") mangled mid-word into "[unverified]st", and a numbered-list
 * recommendation line ("1. Cut back on sodium") whose marker got flagged as a
 * bare figure. Each new case is paired with an adversarial case proving a
 * genuine fabrication in the SAME shape is still caught.
 */
import { describe, expect, it } from "vitest";

import {
  collectNumericLeaves,
  findUnverifiedCoachNumbers,
  stripUnverifiedNumbers,
} from "@/lib/ai/coach/coach-prose-grounding";

describe("collectNumericLeaves", () => {
  it("walks numbers, numeric strings, arrays and nested objects", () => {
    const out = new Set<number>();
    collectNumericLeaves(
      {
        section: { avgSys30: 128, label: "LDL", value: "120" },
        recent: [{ v: 72 }, { v: "1.2" }],
      },
      out,
    );
    expect(out.has(128)).toBe(true);
    expect(out.has(120)).toBe(true);
    expect(out.has(72)).toBe(true);
    expect(out.has(1.2)).toBe(true);
  });
});

describe("findUnverifiedCoachNumbers", () => {
  const payloads = [{ aggregate: { avgSys30: 128, avgDia30: 82 } }];

  it("returns nothing when every cited number is grounded", () => {
    const prose =
      "Your systolic averaged 128 and diastolic 82 over the last 30 days.";
    expect(findUnverifiedCoachNumbers(prose, payloads)).toEqual([]);
  });

  it("flags a drifted number the tools never returned", () => {
    const prose = "Your systolic averaged about 138 recently.";
    const findings = findUnverifiedCoachNumbers(prose, payloads);
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(138);
  });

  it("allows a rounding within tolerance", () => {
    const prose = "Diastolic sat around 82.0 this period.";
    expect(findUnverifiedCoachNumbers(prose, payloads)).toEqual([]);
  });

  it("exempts structural window + small-ordinal integers", () => {
    const prose = "Over the last 30 days, 2 readings stood out of 7 total.";
    // 30 + 7 are window integers; 2 is a small ordinal — none graded.
    const findings = findUnverifiedCoachNumbers(prose, [{ x: 999 }]);
    expect(findings).toEqual([]);
  });

  it("no-ops when no tool returned any figure", () => {
    const prose = "Your systolic averaged 138 recently.";
    expect(findUnverifiedCoachNumbers(prose, [])).toEqual([]);
    expect(
      findUnverifiedCoachNumbers(prose, [{ note: "no numbers here" }]),
    ).toEqual([]);
  });

  it("returns empty on empty prose", () => {
    expect(findUnverifiedCoachNumbers("", payloads)).toEqual([]);
  });

  describe("derived arithmetic (delta / average / percent)", () => {
    // A realistic weight tool-result payload: the model was given latest,
    // avg7 and avg30 — never a pre-computed delta (unlike the Daily
    // Briefing's `signalsOfDay`), so a correctly-computed "down 3.5 kg from
    // your 7-day average" is a legitimate derivation the checker must not
    // flag.
    const weightPayload = [
      {
        metric: "weight",
        section: { aggregate: { latest: 72.4, avg7: 75.9, avg30: 74.1 } },
      },
    ];

    it("does not flag a correctly-computed delta between two grounded aggregate points", () => {
      const prose =
        "You're down 3.5 kg from your 7-day average of 75.9 kg, now at 72.4 kg — nice trend.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("does not flag a correctly-computed midpoint average of two grounded aggregate points", () => {
      const prose =
        "Your latest (72.4 kg) and 30-day average (74.1 kg) put you around 73.25 kg overall.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("does not flag a correctly-computed percent change between two grounded aggregate points", () => {
      // (75.9 - 72.4) / 75.9 * 100 ≈ 4.61%
      const prose = "That's roughly a 4.6% drop from your 7-day average.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("still flags a fabricated figure that is NOT a derived value of the grounded points", () => {
      const prose =
        "Your latest reading was 72.4 kg, and I estimate you'll hit 55.0 kg by next month.";
      const findings = findUnverifiedCoachNumbers(prose, weightPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(55);
    });

    it("does not let a weight delta ground itself against an unrelated metric's figure (per-payload scoping)", () => {
      // Blood pressure's own aggregate lives in a SEPARATE tool-result
      // payload; a "difference" here must derive only from ITS OWN points,
      // never pool with the unrelated weight payload above.
      const bpAndWeight = [
        ...weightPayload,
        {
          metric: "bp",
          section: { aggregate: { avgSys30: 128, avgDia30: 82 } },
        },
      ];
      // 46 is |128 - 82| — a legitimate BP pulse-pressure-shaped delta —
      // grounded via the bp payload's own points, not a coincidence.
      expect(
        findUnverifiedCoachNumbers(
          "Your pulse pressure is about 46.",
          bpAndWeight,
        ),
      ).toEqual([]);
    });
  });

  describe("date ordinals and numbered-list markers", () => {
    const bpPayload = [
      {
        metric: "bp",
        section: { aggregate: { latest: 138, avg7: 132, avg30: 128 } },
      },
    ];

    it("does not flag a day-of-month ordinal even though the bare day number is ungrounded", () => {
      const prose =
        "Your blood pressure spiked to 138 on July 21st, well above your typical range.";
      expect(findUnverifiedCoachNumbers(prose, bpPayload)).toEqual([]);
    });

    it("does not corrupt the ordinal suffix when soft-stripping the rest of the reply", () => {
      // Regression guard for the exact mangling reported: "[unverified]st".
      const prose =
        "Your blood pressure spiked to 138 on July 21st, well above your typical range.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      const { prose: out } = stripUnverifiedNumbers(prose, findings);
      expect(out).not.toContain("[unverified]st");
      expect(out).toBe(prose);
    });

    it("does not flag numbered-list recommendation markers", () => {
      // Item numbers run past 3 (the pre-existing small-ordinal exemption) so
      // this genuinely exercises the line-start list-marker mask, not the
      // unrelated small-integer rule.
      const prose =
        "Your systolic hit 138 today. A few ideas:\n1. Cut back on sodium\n2. Take a short walk after meals\n3. Log your next reading tomorrow\n4. Recheck in the evening\n5. Note any stress today";
      expect(findUnverifiedCoachNumbers(prose, bpPayload)).toEqual([]);
    });

    it("still flags a fabricated figure sitting right next to a date ordinal", () => {
      const prose = "On July 21st your systolic hit 199, a new high.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199);
    });

    it("still flags a genuine leading figure that happens to open a line (not list-shaped without the trailing space)", () => {
      // "199kg" has no space after the number at all — never mistaken for a
      // "N. " list marker, which requires a literal dot-then-space.
      const prose = "199kg would be an alarming reading.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199);
    });

    it("still flags a decimal figure that opens a line (a digit, not whitespace, follows the dot)", () => {
      // "199.5" at line-start is a genuine decimal reading, not a "N. " list
      // marker — the masking regex only fires when whitespace follows the
      // dot, so this stays fully checked.
      const prose = "199.5 would be an alarming systolic reading.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199.5);
    });
  });

  it("still flags a drifted number when the prose also derives / dates cleanly (adversarial floor)", () => {
    // The classic P6 regression case must survive every new exemption.
    const findings = findUnverifiedCoachNumbers(
      "Your systolic averaged about 138 recently.",
      payloads,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(138);
  });
});

describe("stripUnverifiedNumbers", () => {
  it("replaces only the flagged tokens, leaving grounded numbers intact", () => {
    const prose = "Systolic 128, but it spiked to 138 yesterday.";
    const findings = [{ value: 138, source: "138" }];
    const { prose: out, stripped } = stripUnverifiedNumbers(prose, findings);
    expect(stripped).toBe(1);
    expect(out).toContain("128");
    expect(out).toContain("[unverified]");
    expect(out).not.toContain("138");
  });

  it("is a no-op when nothing was flagged", () => {
    const { prose, stripped } = stripUnverifiedNumbers("all good", []);
    expect(prose).toBe("all good");
    expect(stripped).toBe(0);
  });
});
