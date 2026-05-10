import { describe, expect, it } from "vitest";

import { parseKeyValueLine, parseKeyValuesSentinel } from "../keyvalues";

/**
 * v1.4.22 Wave 3 B1+B2 — Coach evidence-block sentinel parser.
 */
describe("parseKeyValueLine", () => {
  it("parses a full line with unit + window", () => {
    expect(
      parseKeyValueLine("avg30 systolic: 138 [mmHg] (last30days)"),
    ).toEqual({
      label: "avg30 systolic",
      value: "138",
      unit: "mmHg",
      window: "last30days",
    });
  });

  it("parses a line with unit but no window (day-level pin)", () => {
    expect(parseKeyValueLine("Tue 6 May: 142/88 [mmHg]")).toEqual({
      label: "Tue 6 May",
      value: "142/88",
      unit: "mmHg",
    });
  });

  it("parses a line with neither unit nor window", () => {
    expect(parseKeyValueLine("30-day adherence: 96")).toEqual({
      label: "30-day adherence",
      value: "96",
    });
  });

  it("tolerates extra whitespace around tokens", () => {
    expect(
      parseKeyValueLine("  avg30 systolic :  138   [mmHg]   (last30days)  "),
    ).toEqual({
      label: "avg30 systolic",
      value: "138",
      unit: "mmHg",
      window: "last30days",
    });
  });

  it("returns null for an empty line", () => {
    expect(parseKeyValueLine("")).toBeNull();
    expect(parseKeyValueLine("   ")).toBeNull();
  });

  it("returns null for a line with no colon", () => {
    expect(parseKeyValueLine("no separator here")).toBeNull();
  });

  it("returns null when the label is empty", () => {
    expect(parseKeyValueLine(": 138")).toBeNull();
  });

  it("returns null when the value would be empty", () => {
    expect(parseKeyValueLine("label only:")).toBeNull();
  });
});

describe("parseKeyValuesSentinel", () => {
  it("strips the sentinel block out of the prose", () => {
    const raw = [
      "Your last week sits a touch higher than your usual run.",
      "",
      "---KEYVALUES---",
      "avg7 systolic: 138 [mmHg] (last7days)",
      "avg30 systolic: 134 [mmHg] (last30days)",
      "---END---",
    ].join("\n");

    const out = parseKeyValuesSentinel(raw);
    expect(out.prose).toBe(
      "Your last week sits a touch higher than your usual run.",
    );
    expect(out.keyValues).toEqual([
      {
        label: "avg7 systolic",
        value: "138",
        unit: "mmHg",
        window: "last7days",
      },
      {
        label: "avg30 systolic",
        value: "134",
        unit: "mmHg",
        window: "last30days",
      },
    ]);
    expect(out.malformed).toBe(false);
  });

  it("returns prose untouched when no sentinel is present", () => {
    const out = parseKeyValuesSentinel(
      "Just a qualitative reply with no numbers cited.",
    );
    expect(out.prose).toBe("Just a qualitative reply with no numbers cited.");
    expect(out.keyValues).toEqual([]);
    expect(out.malformed).toBe(false);
  });

  it("graceful-degrades when the closing ---END--- is missing", () => {
    const raw = [
      "Prose still streams cleanly.",
      "",
      "---KEYVALUES---",
      "avg7 systolic: 138 [mmHg] (last7days)",
    ].join("\n");
    const out = parseKeyValuesSentinel(raw);
    // Prose stripped, body parsed, but flagged malformed so the route
    // can log a wide-event for ops visibility.
    expect(out.prose).toBe("Prose still streams cleanly.");
    expect(out.keyValues.length).toBe(1);
    expect(out.malformed).toBe(true);
  });

  it("clips the block to 8 entries (prompt-contract cap)", () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `metric-${i}: ${100 + i} [mmHg] (last30days)`,
    );
    const raw = ["---KEYVALUES---", ...lines, "---END---"].join("\n");
    const out = parseKeyValuesSentinel(raw);
    expect(out.keyValues.length).toBe(8);
    expect(out.keyValues[0].label).toBe("metric-0");
    expect(out.keyValues[7].label).toBe("metric-7");
  });

  it("clips an oversized block at the 1 KB cap", () => {
    // 1 200 bytes of label/value pairs — every line passes the regex,
    // but the parser trims to 1 024 bytes before splitting so we end
    // up with whichever rows fit.
    const padded = Array.from(
      { length: 60 },
      (_, i) => `label-${i}: ${i.toString().padEnd(15, "x")}`,
    );
    const raw = ["---KEYVALUES---", ...padded, "---END---"].join("\n");
    const out = parseKeyValuesSentinel(raw);
    expect(out.keyValues.length).toBeLessThanOrEqual(8);
    expect(out.malformed).toBe(true);
  });

  it("silently drops malformed lines mixed in with valid ones", () => {
    const raw = [
      "Prose.",
      "",
      "---KEYVALUES---",
      "avg30 systolic: 138 [mmHg] (last30days)",
      "not a valid line",
      ":no-label-here",
      "avg30 mood: 4.1 [/5] (last30days)",
      "---END---",
    ].join("\n");
    const out = parseKeyValuesSentinel(raw);
    expect(out.keyValues.length).toBe(2);
    expect(out.keyValues.map((k) => k.label)).toEqual([
      "avg30 systolic",
      "avg30 mood",
    ]);
  });

  it("returns malformed when the sentinel block is empty", () => {
    const raw = ["Prose.", "---KEYVALUES---", "---END---"].join("\n");
    const out = parseKeyValuesSentinel(raw);
    expect(out.keyValues).toEqual([]);
    expect(out.malformed).toBe(true);
    expect(out.prose).toBe("Prose.");
  });

  it("returns prose and an empty array for empty input", () => {
    const out = parseKeyValuesSentinel("");
    expect(out.prose).toBe("");
    expect(out.keyValues).toEqual([]);
    expect(out.malformed).toBe(false);
  });
});
