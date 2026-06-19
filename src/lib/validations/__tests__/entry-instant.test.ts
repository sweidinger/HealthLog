import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

import {
  isPlausibleEntryInstant,
  validateEntryInstant,
  ENTRY_INSTANT_CLOCK_SKEW_MS,
  ENTRY_INSTANT_FAR_PAST,
} from "../entry-instant";

const NOW = Date.parse("2026-06-14T12:00:00.000Z");

describe("isPlausibleEntryInstant", () => {
  it("accepts a recent past instant", () => {
    expect(isPlausibleEntryInstant(new Date(NOW - 60_000), { now: NOW })).toBe(
      true,
    );
  });

  it("accepts an instant inside the clock-skew tolerance", () => {
    expect(
      isPlausibleEntryInstant(new Date(NOW + ENTRY_INSTANT_CLOCK_SKEW_MS - 1), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a future instant beyond the skew tolerance", () => {
    expect(
      isPlausibleEntryInstant(
        new Date(NOW + ENTRY_INSTANT_CLOCK_SKEW_MS + 60_000),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("rejects an instant before the 1900 far-past floor", () => {
    expect(
      isPlausibleEntryInstant(new Date(ENTRY_INSTANT_FAR_PAST.getTime() - 1), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("accepts a deeply-backdated instant when no maxAge is set", () => {
    expect(
      isPlausibleEntryInstant(new Date("1950-03-04T00:00:00.000Z"), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("honours a tighter maxAge window", () => {
    const fiveYears = 5 * 365 * 24 * 60 * 60 * 1000;
    expect(
      isPlausibleEntryInstant(new Date(NOW - fiveYears + 60_000), {
        now: NOW,
        maxAgeMs: fiveYears,
      }),
    ).toBe(true);
    expect(
      isPlausibleEntryInstant(new Date(NOW - fiveYears - 60_000), {
        now: NOW,
        maxAgeMs: fiveYears,
      }),
    ).toBe(false);
  });
});

describe("validateEntryInstant — Zod integration", () => {
  const schema = validateEntryInstant(
    z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  );

  it("rejects a future-dated instant", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(schema.safeParse(future).success).toBe(false);
  });

  it("accepts a sane backdated instant", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(schema.safeParse(past).success).toBe(true);
  });

  it("rejects an instant before 1900", () => {
    expect(schema.safeParse("1899-12-31T00:00:00.000Z").success).toBe(false);
  });

  it("emits ONLY the future message for a future instant, not a spurious past-bound error", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r = schema.safeParse(future);
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages).toContain("Timestamp must not be in the future");
      expect(messages.some((m) => /past|1900/.test(m))).toBe(false);
    }
  });
});
