import { describe, expect, it } from "vitest";

import { summariseTitle } from "../persistence";

describe("summariseTitle", () => {
  it("returns the input unchanged when below 80 chars", () => {
    const out = summariseTitle("Why is my BP higher this week?");
    expect(out).toBe("Why is my BP higher this week?");
  });

  it("collapses runs of whitespace", () => {
    const out = summariseTitle("Why    is\n\tmy BP\thigher?");
    expect(out).toBe("Why is my BP higher?");
  });

  it("trims leading and trailing whitespace", () => {
    const out = summariseTitle("   plenty of room   ");
    expect(out).toBe("plenty of room");
  });

  it("appends ellipsis when input is over 80 chars", () => {
    const long =
      "Could you walk me through the relationship between my morning blood pressure spikes and the late evening medication doses I took last week, including any noticeable patterns?";
    const out = summariseTitle(long);
    expect(out.endsWith("…")).toBe(true);
    // Visible width capped to 80
    expect([...out].length).toBeLessThanOrEqual(80);
  });

  it("cuts at a word boundary when one is within reach", () => {
    const long =
      "Walk me through the morning blood pressure trend I have been tracking since the last visit at the clinic in Hamburg this past month";
    const out = summariseTitle(long);
    // No trailing whitespace before the ellipsis
    expect(out).not.toMatch(/\s+…$/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to a default title for empty input", () => {
    expect(summariseTitle("")).toBe("New conversation");
    expect(summariseTitle("    ")).toBe("New conversation");
  });
});
