import { describe, it, expect } from "vitest";
import {
  inferMedTargetClass,
  primaryTargetForClass,
  MED_TARGET_MAP,
  resolveMedicationTargets,
  targetsForEfficacyClass,
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

describe("resolveMedicationTargets — three-tier efficacy resolution", () => {
  it("prefers the ATC class prefix over the name", () => {
    // C09 (ACE/ARB) → blood pressure, even when the name is unrecognised.
    const r = resolveMedicationTargets({
      name: "SomeUnknownBrand",
      atcCode: "C09AA05",
    });
    expect(r?.tier).toBe("atc");
    expect(r?.cls).toBe("antihypertensive");
    expect(r?.targets[0]).toEqual({
      kind: "metric",
      measurementType: "BLOOD_PRESSURE_SYS",
    });
  });

  it("maps the lipid-modifier ATC class to an LDL lab target", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "C10AA05" });
    expect(r?.cls).toBe("statin");
    expect(r?.targets[0]).toEqual({
      kind: "lab",
      analyte: "LDL",
      label: "LDL cholesterol",
    });
  });

  it("routes the GLP-1 ATC leaf to glucose+weight, not the A10 fallback", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "A10BJ06" });
    expect(r?.cls).toBe("glp1");
    const other = resolveMedicationTargets({ name: "x", atcCode: "A10BA02" });
    expect(other?.cls).toBe("antidiabetic");
  });

  it("maps thyroid ATC to a TSH lab target", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "H03AA01" });
    expect(r?.cls).toBe("thyroid");
    expect(r?.targets[0].kind).toBe("lab");
  });

  it("falls back to name inference when no valid ATC code is present", () => {
    const r = resolveMedicationTargets({ name: "Atorvastatin 20mg" });
    expect(r?.tier).toBe("name");
    expect(r?.cls).toBe("statin");
    const bp = resolveMedicationTargets({ name: "Ramipril" });
    expect(bp?.tier).toBe("name");
    expect(bp?.cls).toBe("antihypertensive");
  });

  it("infers supplement lab targets by name", () => {
    expect(resolveMedicationTargets({ name: "Cholecalciferol" })?.cls).toBe(
      "vitamin_d",
    );
    expect(
      resolveMedicationTargets({ name: "Ferrous sulfate 200mg" })?.cls,
    ).toBe("iron");
  });

  it("ignores a malformed ATC code and falls through to the name", () => {
    const r = resolveMedicationTargets({
      name: "Ramipril",
      atcCode: "not-an-atc",
    });
    expect(r?.tier).toBe("name");
    expect(r?.cls).toBe("antihypertensive");
  });

  it("conservative-fails to null for an unknown med with no ATC", () => {
    expect(resolveMedicationTargets({ name: "Aspirin" })).toBeNull();
    expect(resolveMedicationTargets({ name: "" })).toBeNull();
  });

  it("exposes the ordered target list per efficacy class", () => {
    expect(targetsForEfficacyClass("antihypertensive")).toHaveLength(2);
    expect(targetsForEfficacyClass("thyroid")[0]).toEqual({
      kind: "lab",
      analyte: "TSH",
      label: "TSH",
    });
  });
});
