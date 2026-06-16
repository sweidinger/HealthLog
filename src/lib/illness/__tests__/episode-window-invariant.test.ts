/**
 * v1.18.1 — the `resolvedAt >= onsetAt` window invariant on the illness
 * episode schemas. An episode can never resolve before it began; the schema
 * `superRefine` rejects an inverted window when both instants are supplied
 * (a partial edit touching only one is checked against the stored row in the
 * route).
 */
import { describe, expect, it } from "vitest";
import {
  illnessEpisodeCreateSchema,
  illnessEpisodeUpdateSchema,
} from "@/lib/validations/illness";

const ONSET = "2026-01-10T08:00:00Z";
const BEFORE = "2026-01-08T08:00:00Z";
const AFTER = "2026-01-15T08:00:00Z";

describe("illnessEpisodeCreateSchema — window invariant", () => {
  it("rejects resolvedAt earlier than onsetAt", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
      resolvedAt: BEFORE,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.path.includes("resolvedAt"))).toBe(
        true,
      );
    }
  });

  it("accepts resolvedAt on/after onsetAt", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
      resolvedAt: AFTER,
    });
    expect(out.success).toBe(true);
  });

  it("accepts a create with only onsetAt (no resolvedAt)", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
    });
    expect(out.success).toBe(true);
  });
});

describe("illnessEpisodeUpdateSchema — window invariant", () => {
  it("rejects a both-in-body inverted window", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: ONSET,
      resolvedAt: BEFORE,
    });
    expect(out.success).toBe(false);
  });

  it("accepts a partial edit touching only resolvedAt (route merges vs stored)", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({ resolvedAt: AFTER });
    expect(out.success).toBe(true);
  });
});
