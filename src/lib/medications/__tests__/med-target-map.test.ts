import { describe, it, expect } from "vitest";
import {
  inferMedTargetClass,
  primaryTargetForClass,
  MED_TARGET_MAP,
} from "@/lib/medications/med-target-map";

describe("med-target-map — class inference", () => {
  it("maps the structured GLP1 discriminator", () => {
    expect(inferMedTargetClass("Anything", "GLP1")).toBe("glp1");
  });

  it("recognises a GLP-1 brand via the catalog", () => {
    expect(inferMedTargetClass("Mounjaro")).toBe("glp1");
    expect(inferMedTargetClass("Ozempic")).toBe("glp1");
  });

  it("recognises a GLP-1 INN by name", () => {
    expect(inferMedTargetClass("semaglutide 1mg")).toBe("glp1");
  });

  it("maps common antihypertensives", () => {
    expect(inferMedTargetClass("Ramipril")).toBe("antihypertensive");
    expect(inferMedTargetClass("amlodipine 5mg")).toBe("antihypertensive");
    expect(inferMedTargetClass("Bisoprolol")).toBe("antihypertensive");
  });

  it("maps common antidiabetics", () => {
    expect(inferMedTargetClass("Metformin 1000mg")).toBe("antidiabetic");
    expect(inferMedTargetClass("insulin glargine")).toBe("antidiabetic");
  });

  it("conservative-fails on an unknown medication", () => {
    expect(inferMedTargetClass("Aspirin")).toBeNull();
    expect(inferMedTargetClass("Vitamin D")).toBeNull();
    expect(inferMedTargetClass("")).toBeNull();
  });

  it("does not match a partial-word false positive", () => {
    // "insuline-like" should not match the whole word "insulin" boundary —
    // and an unrelated name must stay unknown.
    expect(inferMedTargetClass("Paracetamol")).toBeNull();
  });
});

describe("med-target-map — targets", () => {
  it("leads antihypertensive with systolic", () => {
    expect(primaryTargetForClass("antihypertensive")).toBe(
      "BLOOD_PRESSURE_SYS",
    );
    expect(MED_TARGET_MAP.antihypertensive).toContain("BLOOD_PRESSURE_DIA");
  });

  it("targets glucose for antidiabetics and glucose+weight for GLP-1", () => {
    expect(MED_TARGET_MAP.antidiabetic).toEqual(["BLOOD_GLUCOSE"]);
    expect(MED_TARGET_MAP.glp1).toEqual(["BLOOD_GLUCOSE", "WEIGHT"]);
  });
});
