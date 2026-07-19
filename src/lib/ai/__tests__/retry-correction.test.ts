/**
 * The corrective retry prompt and the validator that grades the retry reply
 * must describe ONE contract.
 *
 * The prompt used to demand the dead strict wrapper's shape — `citations[]`,
 * `warnings[]`, and a mandatory `metricSource` / `rationale` / `id` /
 * `severity` on every recommendation — while naming none of the five fields
 * `insightResultSchema` actually requires. A model that obeyed the correction
 * produced a reply the validator could not accept, so the one corrective pass
 * spent budget steering the generation away from its own contract.
 *
 * These tests pin both directions: the example the prompt hands the model
 * validates, and the prompt names every required key without naming a key the
 * validator does not have.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

import {
  buildRetryCorrectionMessage,
  RETRY_CONTRACT_EXAMPLE,
} from "@/lib/ai/retry-correction";
import { insightResultSchema } from "@/lib/ai/types";

/** Top-level keys `insightResultSchema` requires (no `.optional()`). */
function requiredSchemaKeys(): string[] {
  const shape = (insightResultSchema as unknown as z.ZodObject).shape;
  return Object.entries(shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key);
}

/** Every top-level key the schema knows about, required or optional. */
function allSchemaKeys(): string[] {
  return Object.keys((insightResultSchema as unknown as z.ZodObject).shape);
}

describe("buildRetryCorrectionMessage — prompt matches the validator", () => {
  it("hands the model an example that the validator accepts", () => {
    const parsed = insightResultSchema.safeParse(RETRY_CONTRACT_EXAMPLE);
    expect(parsed.success).toBe(true);
  });

  it("embeds that example verbatim in the corrective message", () => {
    const message = buildRetryCorrectionMessage("reason", "details");
    expect(message).toContain(JSON.stringify(RETRY_CONTRACT_EXAMPLE, null, 2));
  });

  it("names every field the validator requires", () => {
    const message = buildRetryCorrectionMessage("reason", "details");
    for (const key of requiredSchemaKeys()) {
      expect(message, `retry prompt omits required field "${key}"`).toContain(
        key,
      );
    }
  });

  it("names no top-level field the validator does not have", () => {
    const message = buildRetryCorrectionMessage("reason", "details");
    const known = new Set(allSchemaKeys());
    // The dead wrapper's two invented top-level arrays. Asserted by name
    // rather than by diffing prose, so the check cannot go vacuous.
    for (const stale of ["citations", "warnings"]) {
      expect(known.has(stale)).toBe(false);
      expect(
        message,
        `retry prompt still demands the removed "${stale}" field`,
      ).not.toContain(stale);
    }
  });

  it("marks the optional recommendation fields as optional", () => {
    const message = buildRetryCorrectionMessage("reason", "details");
    // `metricSource` and `rationale` are `.optional()` on the validator; the
    // prompt must not demand them or a grounded-but-sparse reply gets a
    // needless second round trip.
    expect(message).toMatch(/OPTIONAL/);
    expect(message).not.toMatch(/Every recommendation MUST carry/);
  });

  it("passes the caller's reason and truncated details through", () => {
    const message = buildRetryCorrectionMessage("bad-json", "x".repeat(2000));
    expect(message).toContain("bad-json");
    expect(message).toContain("x".repeat(1024));
    expect(message).not.toContain("x".repeat(1025));
  });
});
