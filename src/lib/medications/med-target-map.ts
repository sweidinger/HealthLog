/**
 * v1.22 (W9, B5) — closed medication-class → target-vital map.
 *
 * The adherence→symptom storyline needs to know which VITAL a medication is
 * meant to move, so the Coach can say "the vital this drug targets drifted",
 * not just "an outcome moved". Today the only drug-class knowledge in the tree
 * is the GLP-1 catalog (`glp1-knowledge.ts`); this generalises that, minimally
 * and conservatively, into a hand-curated class→`MeasurementType[]` table.
 *
 * Design rules (all safety-relevant):
 *  - The table is CLOSED. A medication whose class we cannot confidently infer
 *    maps to `null` — and a null class yields NO storyline. We never guess a
 *    target; a wrong target is a wrong medication claim.
 *  - Only classes with a first-class `MeasurementType` target are listed. Statin
 *    (LDL) and thyroid (TSH) act on LAB analytes that live in `LabResult`, not
 *    the measurement series the storyline reads, so they are deliberately
 *    OUT of scope for v1.22 (documented here, not silently dropped).
 *  - Class inference is whole-word, case-insensitive INN/brand matching plus the
 *    structured `treatmentClass` discriminator + the GLP-1 catalog. No fuzzy
 *    matching — a partial hit is treated as unknown.
 *
 * The storyline that consumes this stays association-only and never advises a
 * dose change; that framing is enforced in the prompt + the B0 eval cases.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { findDrugIdByBrand } from "@/lib/medications/glp1-knowledge";

/** The medication classes the storyline can reason about (closed set). */
export type MedTargetClass = "antihypertensive" | "antidiabetic" | "glp1";

/**
 * Class → the vital(s) the class is prescribed to move. Conservative: every
 * entry is a metric stored as a first-class `MeasurementType` series, so the
 * storyline can read a DAY-bucket mean for it. Statin→LDL and thyroid→TSH are
 * intentionally absent (lab analytes, not measurement series — a follow-on).
 */
export const MED_TARGET_MAP: Readonly<
  Record<MedTargetClass, readonly MeasurementType[]>
> = {
  // Antihypertensives move blood pressure. Systolic leads the storyline
  // (the number users track); diastolic is the secondary target.
  antihypertensive: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  // Oral/injectable antidiabetics (metformin, sulfonylureas, SGLT2, DPP-4,
  // insulin) move blood glucose.
  antidiabetic: ["BLOOD_GLUCOSE"],
  // GLP-1 / GIP agonists move glucose and weight; both are first-class series.
  glp1: ["BLOOD_GLUCOSE", "WEIGHT"],
} as const;

/** The primary (storyline-leading) target for a class. */
export function primaryTargetForClass(cls: MedTargetClass): MeasurementType {
  return MED_TARGET_MAP[cls][0];
}

/**
 * Whole-word INN/brand needles per class. Each list is conservative — common
 * generics and brands only — so a name we do not recognise stays unknown
 * (conservative-fail) rather than being mapped to a plausible-but-wrong class.
 * GLP-1 is resolved separately via the structured catalog, not by this list.
 */
const ANTIHYPERTENSIVE_NEEDLES: readonly string[] = [
  // ACE inhibitors
  "ramipril",
  "lisinopril",
  "enalapril",
  "perindopril",
  "captopril",
  // ARBs
  "losartan",
  "candesartan",
  "valsartan",
  "irbesartan",
  "telmisartan",
  "olmesartan",
  // calcium-channel blockers
  "amlodipine",
  "nifedipine",
  "lercanidipine",
  "felodipine",
  // beta blockers (BP/HR)
  "bisoprolol",
  "metoprolol",
  "carvedilol",
  "nebivolol",
  "atenolol",
  // diuretics
  "hydrochlorothiazide",
  "indapamide",
  "chlortalidone",
  "furosemide",
  // alpha blockers
  "doxazosin",
];

const ANTIDIABETIC_NEEDLES: readonly string[] = [
  "metformin",
  "insulin",
  "gliclazide",
  "glimepiride",
  "glibenclamide",
  "sitagliptin",
  "linagliptin",
  "saxagliptin",
  "empagliflozin",
  "dapagliflozin",
  "canagliflozin",
  "pioglitazone",
  "repaglinide",
];

const GLP1_INN_NEEDLES: readonly string[] = [
  "semaglutide",
  "tirzepatide",
  "liraglutide",
  "dulaglutide",
  "exenatide",
];

/** Lowercase, trim — the comparison form for a med name. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/** True when `name` contains `needle` as a whole word (no partial hits). */
function containsWord(name: string, needle: string): boolean {
  const re = new RegExp(`(?:^|[^a-z])${needle}(?:[^a-z]|$)`, "i");
  return re.test(name);
}

/**
 * Infer the target-class of a medication from its structured discriminator,
 * the GLP-1 catalog, and a whole-word name match — in that priority order.
 * Returns `null` when the class is not confidently known: the caller then
 * surfaces NO storyline for that medication (conservative-fail, never a guess).
 *
 * `treatmentClass` is the `MedicationCategory` enum on `Medication`
 * (`GENERIC` | `GLP1`). Passing it is optional so a name-only caller still
 * works.
 */
export function inferMedTargetClass(
  name: string,
  treatmentClass?: string | null,
): MedTargetClass | null {
  if (treatmentClass === "GLP1") return "glp1";

  const normalised = normaliseName(name);
  if (!normalised) return null;

  // The structured GLP-1 catalog is authoritative for its brands/INNs.
  if (findDrugIdByBrand(normalised) !== null) return "glp1";
  if (GLP1_INN_NEEDLES.some((n) => containsWord(normalised, n))) return "glp1";

  if (ANTIDIABETIC_NEEDLES.some((n) => containsWord(normalised, n))) {
    return "antidiabetic";
  }
  if (ANTIHYPERTENSIVE_NEEDLES.some((n) => containsWord(normalised, n))) {
    return "antihypertensive";
  }
  return null;
}
