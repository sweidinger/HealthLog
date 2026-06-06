/**
 * v1.15.1 — custom cycle-symptom helpers: key mint/detect, label encrypt /
 * decrypt fail-soft, and the Zod create/update schemas.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
    return s.replace(/^enc:/, "");
  },
}));

import {
  CUSTOM_SYMPTOM_KEY_PREFIX,
  MAX_CUSTOM_SYMPTOMS_PER_USER,
  createCustomSymptomSchema,
  decryptCustomLabel,
  encryptCustomLabel,
  isCustomSymptomKey,
  mintCustomSymptomKey,
  updateCustomSymptomSchema,
} from "@/lib/cycle/custom-symptoms";

describe("custom-symptom keys", () => {
  it("mints a custom:<uuid> key the detector recognises", () => {
    const key = mintCustomSymptomKey();
    expect(key.startsWith(CUSTOM_SYMPTOM_KEY_PREFIX)).toBe(true);
    expect(isCustomSymptomKey(key)).toBe(true);
  });

  it("does not treat a bare catalogue slug as custom", () => {
    expect(isCustomSymptomKey("cramps")).toBe(false);
    expect(isCustomSymptomKey("headache")).toBe(false);
  });

  it("mints unique keys", () => {
    expect(mintCustomSymptomKey()).not.toBe(mintCustomSymptomKey());
  });
});

describe("label encryption", () => {
  it("round-trips a label through encrypt/decrypt", () => {
    const enc = encryptCustomLabel("Schwindel");
    expect(enc).toBe("enc:Schwindel");
    expect(decryptCustomLabel(enc)).toBe("Schwindel");
  });

  it("decrypts a corrupt/missing ciphertext fail-soft to null", () => {
    expect(decryptCustomLabel(null)).toBeNull();
    expect(decryptCustomLabel("not-encrypted")).toBeNull();
  });
});

describe("create schema", () => {
  it("accepts a label + allow-listed icon", () => {
    const p = createCustomSymptomSchema.safeParse({
      label: "Dizziness",
      icon: "Brain",
    });
    expect(p.success).toBe(true);
  });

  it("rejects an empty label and an over-long one", () => {
    expect(createCustomSymptomSchema.safeParse({ label: "" }).success).toBe(
      false,
    );
    expect(
      createCustomSymptomSchema.safeParse({ label: "x".repeat(41) }).success,
    ).toBe(false);
  });

  it("rejects an icon outside the allow-list", () => {
    expect(
      createCustomSymptomSchema.safeParse({ label: "X", icon: "Skull" })
        .success,
    ).toBe(false);
  });

  it("rejects a categoryKey other than custom", () => {
    expect(
      createCustomSymptomSchema.safeParse({ label: "X", categoryKey: "physical" })
        .success,
    ).toBe(false);
  });
});

describe("update schema", () => {
  it("requires at least one field", () => {
    expect(updateCustomSymptomSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a partial update", () => {
    expect(
      updateCustomSymptomSchema.safeParse({ isActive: false }).success,
    ).toBe(true);
    expect(updateCustomSymptomSchema.safeParse({ label: "New" }).success).toBe(
      true,
    );
  });
});

describe("per-user cap", () => {
  it("pins a sane ceiling", () => {
    expect(MAX_CUSTOM_SYMPTOMS_PER_USER).toBe(50);
  });
});
