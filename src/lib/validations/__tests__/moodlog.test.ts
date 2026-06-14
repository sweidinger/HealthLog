import { describe, expect, it } from "vitest";
import {
  moodLogCredentialsSchema,
  createMoodEntrySchema,
  updateMoodEntrySchema,
} from "../moodlog";

describe("createMoodEntrySchema — note + structured tagKeys (v1.8.5)", () => {
  const base = { mood: "GUT", moodLoggedAt: "2026-06-01T12:00:00.000Z" };

  it("round-trips the note field", () => {
    const r = createMoodEntrySchema.safeParse({ ...base, note: "felt great" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBe("felt great");
  });

  it("accepts structured tagKeys alongside flat tags", () => {
    const r = createMoodEntrySchema.safeParse({
      ...base,
      tags: ["nausea"],
      tagKeys: ["happy", "worked_out"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tagKeys).toEqual(["happy", "worked_out"]);
      expect(r.data.tags).toEqual(["nausea"]);
    }
  });

  it("rejects an over-long note and an over-large tagKeys set", () => {
    expect(
      createMoodEntrySchema.safeParse({ ...base, note: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      createMoodEntrySchema.safeParse({
        ...base,
        tagKeys: Array.from({ length: 31 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });

  it("allows update to clear tagKeys with null", () => {
    const r = updateMoodEntrySchema.safeParse({ tagKeys: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tagKeys).toBeNull();
  });

  // v1.17 W1b — shared `validateEntryInstant` plausibility bound.
  it("rejects a future-dated mood entry", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      createMoodEntrySchema.safeParse({ ...base, moodLoggedAt: future })
        .success,
    ).toBe(false);
  });

  it("accepts a sane backdated mood entry", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      createMoodEntrySchema.safeParse({ ...base, moodLoggedAt: past }).success,
    ).toBe(true);
  });

  it("rejects a mood entry dated before 1900", () => {
    expect(
      createMoodEntrySchema.safeParse({
        ...base,
        moodLoggedAt: "1899-12-31T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("moodLogCredentialsSchema SSRF guard", () => {
  it("accepts a public moodLog URL", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "https://moodlog.app",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(true);
  });

  it("rejects RFC1918 URLs", () => {
    for (const url of [
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://127.0.0.1",
    ]) {
      const r = moodLogCredentialsSchema.safeParse({
        url,
        apiKey: "k".repeat(40),
      });
      expect(r.success, `expected reject for ${url}`).toBe(false);
    }
  });

  it("rejects link-local (cloud metadata) URLs", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(false);
  });

  it("rejects localhost", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "http://localhost:8080",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(false);
  });
});
