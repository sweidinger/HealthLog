/**
 * v1.4.16 H2 — moodEntrySchema.tags must reject malformed tag blobs
 * before the restore transaction inserts them. The DB column stores
 * tags as a JSON-array-as-string ("[\"work\",\"sleep\"]"), so an
 * arbitrary string slipping through Zod is a foot-gun:
 *   - downstream readers `JSON.parse` blindly and crash on a
 *     non-array
 *   - the iOS native client renders tags one-per-row and would
 *     either render garbage or throw
 *
 * We accept three shapes:
 *   - `null` (and omitted/undefined): "no tags on this entry"
 *   - empty string `""`: legacy moodLog wire format (handled as null)
 *   - a JSON-string that parses to an array of strings.
 *
 * Anything else (object, JSON-with-numbers, garbage) is rejected at
 * schema time with a 422 response from the restore endpoint instead
 * of bubbling out of `prisma.createMany` with a useless message.
 */
import { describe, expect, it } from "vitest";
import { backupPayloadSchema } from "../backup";

const baseEntry = {
  date: "2026-05-08",
  mood: "GUT",
  score: 4,
  source: "MOODLOG",
  loggedAt: "2026-05-08T20:00:00.000Z",
};

function parseWithMoodTags(tags: unknown) {
  return backupPayloadSchema.safeParse({
    schemaVersion: "1",
    exportedAt: "2026-05-08T07:00:00.000Z",
    userId: "u1",
    measurements: [],
    medications: [],
    intakeEvents: [],
    moodEntries: [{ ...baseEntry, tags }],
  });
}

describe("moodEntrySchema.tags strict validation", () => {
  it("accepts null", () => {
    const r = parseWithMoodTags(null);
    expect(r.success).toBe(true);
  });

  it("accepts an empty string (legacy moodLog wire format)", () => {
    const r = parseWithMoodTags("");
    expect(r.success).toBe(true);
  });

  it("accepts a JSON-string that parses to an array of strings", () => {
    const r = parseWithMoodTags('["work","sleep"]');
    expect(r.success).toBe(true);
  });

  it("rejects a non-JSON garbage string", () => {
    const r = parseWithMoodTags("not-json{");
    expect(r.success).toBe(false);
  });

  it("rejects a JSON object that is not an array", () => {
    const r = parseWithMoodTags('{"a":1}');
    expect(r.success).toBe(false);
  });

  it("rejects a JSON array containing non-strings", () => {
    const r = parseWithMoodTags("[1,2,3]");
    expect(r.success).toBe(false);
  });

  it("accepts an omitted tags field (optional)", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [{ ...baseEntry }],
    });
    expect(r.success).toBe(true);
  });
});
