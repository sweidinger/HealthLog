/**
 * efficacyTargetOverrideSchema must accept a custom-metric target and keep the
 * "exactly one target, or clear" invariant now that three target kinds exist
 * (measurementType / biomarkerId / customMetricId). A row with two kinds set,
 * or none, would let the API persist an ambiguous override the resolver can't
 * reason about — so it is rejected at schema time with a 422 instead of
 * reaching `prisma.medicationEfficacyTarget.create`.
 */
import { describe, expect, it } from "vitest";
import { efficacyTargetOverrideSchema } from "@/lib/validations/medication-efficacy";

describe("efficacyTargetOverrideSchema — custom-metric target", () => {
  it("accepts a lone customMetricId", () => {
    const r = efficacyTargetOverrideSchema.safeParse({ customMetricId: "cm_1" });
    expect(r.success).toBe(true);
  });

  it("accepts each of the three kinds on its own", () => {
    expect(
      efficacyTargetOverrideSchema.safeParse({ measurementType: "WEIGHT" })
        .success,
    ).toBe(true);
    expect(
      efficacyTargetOverrideSchema.safeParse({ biomarkerId: "bm_1" }).success,
    ).toBe(true);
    expect(
      efficacyTargetOverrideSchema.safeParse({ customMetricId: "cm_1" }).success,
    ).toBe(true);
  });

  it("rejects two kinds set at once", () => {
    expect(
      efficacyTargetOverrideSchema.safeParse({
        measurementType: "WEIGHT",
        customMetricId: "cm_1",
      }).success,
    ).toBe(false);
    expect(
      efficacyTargetOverrideSchema.safeParse({
        biomarkerId: "bm_1",
        customMetricId: "cm_1",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty body (no target and no clear)", () => {
    expect(efficacyTargetOverrideSchema.safeParse({}).success).toBe(false);
  });

  it("accepts clear:true on its own", () => {
    expect(
      efficacyTargetOverrideSchema.safeParse({ clear: true }).success,
    ).toBe(true);
  });

  it("rejects a blank customMetricId", () => {
    expect(
      efficacyTargetOverrideSchema.safeParse({ customMetricId: "   " }).success,
    ).toBe(false);
  });
});
