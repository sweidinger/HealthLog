/**
 * v1.21.0 (P6 / C2-5) — post-hoc numeric verifier on Coach prose. It must flag
 * a number the model cited that no tool returned this turn (transcription
 * drift), exempt structural window/ordinal integers, and no-op when no tool
 * returned figures. Soft-strip replaces only the flagged tokens.
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
