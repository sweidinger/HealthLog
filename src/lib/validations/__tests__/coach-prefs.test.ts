import { describe, expect, it } from "vitest";

import {
  DEFAULT_COACH_PREFS,
  coachPrefsSchema,
  parseCoachPrefs,
} from "../coach-prefs";

/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences.
 */
describe("coachPrefsSchema", () => {
  it("accepts an empty object and fills in defaults", () => {
    const out = coachPrefsSchema.parse({});
    expect(out).toEqual(DEFAULT_COACH_PREFS);
  });

  it("accepts the full shape and round-trips it", () => {
    const input = {
      tone: "concise" as const,
      verbosity: "brief" as const,
      excludeMetrics: ["bp", "weight"] as const,
      showEvidenceByDefault: true,
    };
    const out = coachPrefsSchema.parse(input);
    expect(out).toEqual(input);
  });

  it("rejects unknown tone values", () => {
    const result = coachPrefsSchema.safeParse({ tone: "stoic" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown verbosity values", () => {
    const result = coachPrefsSchema.safeParse({ verbosity: "rambling" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown excludeMetrics entries", () => {
    const result = coachPrefsSchema.safeParse({
      excludeMetrics: ["bp", "horoscope"],
    });
    expect(result.success).toBe(false);
  });

  it("caps excludeMetrics at 9 entries", () => {
    const result = coachPrefsSchema.safeParse({
      excludeMetrics: [
        "bp",
        "weight",
        "pulse",
        "mood",
        "compliance",
        "hrv",
        "sleep",
        "resting_hr",
        "steps",
        "bp",
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseCoachPrefs", () => {
  it("returns defaults for null input", () => {
    expect(parseCoachPrefs(null)).toEqual(DEFAULT_COACH_PREFS);
  });

  it("returns defaults for undefined input", () => {
    expect(parseCoachPrefs(undefined)).toEqual(DEFAULT_COACH_PREFS);
  });

  it("returns defaults for malformed input (forward-compat fallback)", () => {
    expect(parseCoachPrefs({ tone: "stoic" })).toEqual(DEFAULT_COACH_PREFS);
    expect(parseCoachPrefs("not an object")).toEqual(DEFAULT_COACH_PREFS);
  });

  it("preserves a valid shape", () => {
    const input = {
      tone: "neutral" as const,
      verbosity: "default" as const,
      excludeMetrics: ["mood" as const],
      showEvidenceByDefault: true,
    };
    expect(parseCoachPrefs(input)).toEqual(input);
  });
});
