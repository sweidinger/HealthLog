import { describe, expect, test } from "vitest";

import {
  formatTimeWindowPart,
  formatTimeWindowRange,
} from "@/lib/time-window-format";

describe("formatTimeWindowPart", () => {
  test("zero-pads single-digit hours", () => {
    expect(formatTimeWindowPart("8:00")).toBe("08:00");
  });

  test("preserves two-digit hours", () => {
    expect(formatTimeWindowPart("19:30")).toBe("19:30");
  });

  test("returns input unchanged when not a HH:MM string", () => {
    expect(formatTimeWindowPart("invalid")).toBe("invalid");
  });
});

describe("formatTimeWindowRange", () => {
  test("German locale renders 'bis ... Uhr' (default behaviour preserved)", () => {
    expect(formatTimeWindowRange("19:00", "23:00", "de")).toBe(
      "19:00 bis 23:00 Uhr",
    );
  });

  test("English locale renders 'from ... to ...' instead of mixed-language 'bis Uhr'", () => {
    // Regression for v1.4.19 F-01: app rendered "Today, 19:00 bis 23:00 Uhr"
    // for English users because the formatter hard-coded German.
    expect(formatTimeWindowRange("19:00", "23:00", "en")).toBe(
      "19:00 – 23:00",
    );
  });

  test("falls back to the German format when no locale is supplied", () => {
    // Backwards-compat: existing call sites that have not been migrated
    // continue to render the historic German string.
    expect(formatTimeWindowRange("08:00", "12:00")).toBe(
      "08:00 bis 12:00 Uhr",
    );
  });
});
