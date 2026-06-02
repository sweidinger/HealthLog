import { describe, it, expect } from "vitest";

import {
  createMedicationSchema,
  updateMedicationSchema,
} from "@/lib/validations/medication";

/**
 * v1.9.0 — validation coverage for the optional drug-classification
 * codes (`atcCode` / `rxNormCode`) on the medication create + update
 * bodies. ATC format `^[A-Z]\d{2}[A-Z]{2}\d{2}$`, RxCUI `^\d+$`.
 */

const baseCreate = {
  name: "Mounjaro",
  dose: "10mg",
  schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
};

describe("medication drug-code validation", () => {
  describe("createMedicationSchema", () => {
    it("accepts a well-formed ATC + RxNorm code", () => {
      const parsed = createMedicationSchema.safeParse({
        ...baseCreate,
        atcCode: "A10BX10",
        rxNormCode: "2601723",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.atcCode).toBe("A10BX10");
        expect(parsed.data.rxNormCode).toBe("2601723");
      }
    });

    it("accepts a medication with no codes (the pre-v1.9.0 shape)", () => {
      const parsed = createMedicationSchema.safeParse(baseCreate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.atcCode).toBeUndefined();
        expect(parsed.data.rxNormCode).toBeUndefined();
      }
    });

    it("rejects a malformed ATC code", () => {
      // Too short (anatomical-group prefix, not a leaf substance class).
      expect(
        createMedicationSchema.safeParse({ ...baseCreate, atcCode: "A10B" })
          .success,
      ).toBe(false);
      // Lowercase.
      expect(
        createMedicationSchema.safeParse({ ...baseCreate, atcCode: "a10bx10" })
          .success,
      ).toBe(false);
      // Wrong digit/letter layout.
      expect(
        createMedicationSchema.safeParse({ ...baseCreate, atcCode: "AA0BX10" })
          .success,
      ).toBe(false);
    });

    it("rejects a non-numeric RxNorm code", () => {
      expect(
        createMedicationSchema.safeParse({
          ...baseCreate,
          rxNormCode: "rx-260",
        }).success,
      ).toBe(false);
      expect(
        createMedicationSchema.safeParse({ ...baseCreate, rxNormCode: "" })
          .success,
      ).toBe(false);
    });
  });

  describe("updateMedicationSchema", () => {
    it("accepts null to clear a code", () => {
      const parsed = updateMedicationSchema.safeParse({
        atcCode: null,
        rxNormCode: null,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.atcCode).toBeNull();
        expect(parsed.data.rxNormCode).toBeNull();
      }
    });

    it("accepts a well-formed code on update", () => {
      const parsed = updateMedicationSchema.safeParse({ atcCode: "C09AA05" });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.atcCode).toBe("C09AA05");
    });

    it("rejects a malformed code on update", () => {
      expect(
        updateMedicationSchema.safeParse({ atcCode: "not-a-code" }).success,
      ).toBe(false);
      expect(
        updateMedicationSchema.safeParse({ rxNormCode: "12.3" }).success,
      ).toBe(false);
    });
  });
});
