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

// ─── v1.28 efficacy resolver (extends the closed map above) ───────────
//
// The efficacy view ("Wirkung" tab + the Insights summary) needs a target
// resolver that (a) can point at LAB analytes (statin→LDL, thyroid→TSH,
// supplements→their marker) — the documented follow-on the v1.22 map left
// out — and (b) consults the WHO ATC class prefix on `Medication.atcCode`
// before falling back to name inference. It is ADDITIVE: the metric-only
// `MED_TARGET_MAP` / `inferMedTargetClass` / `primaryTargetForClass` above
// stay byte-identical so the adherence-storyline safety path is untouched.
//
// Same discipline as the map above: closed tables, whole-word / fixed-prefix
// matching, conservative-fail to an EMPTY target list (never a guess). The
// clinical association ("this class is prescribed to move this outcome") is
// documented, guideline-cited and vendor-blind in the external knowledge base
// (`medications/drug-class-targets.md`); this code is its mechanical mirror.
// No efficacy claim is encoded here — only what a class is prescribed to move.

/**
 * A resolved target: either a first-class measurement series or a lab analyte.
 * The lab variant carries a `contains`-match needle (matched against a
 * `LabResult.analyte` or the linked `Biomarker.name`, exactly as
 * `getLabHistory` matches) plus a human label for the DTO / UI.
 */
export type MedTarget =
  | { kind: "metric"; measurementType: MeasurementType }
  | { kind: "lab"; analyte: string; label: string }
  | {
      kind: "custom";
      customMetricId: string;
      label: string;
      unit: string | null;
      referenceBand: { low: number; high: number } | null;
    };

/**
 * The wider class set the efficacy resolver reasons about: the three
 * metric classes above plus the lab-analyte classes (statin→LDL,
 * thyroid→TSH) and the two supplement markers named in the plan.
 */
export type EfficacyMedClass =
  MedTargetClass | "statin" | "thyroid" | "vitamin_d" | "iron";

/** Class → its ordered target list (primary first). Closed + conservative. */
const EFFICACY_TARGETS: Readonly<
  Record<EfficacyMedClass, readonly MedTarget[]>
> = {
  antihypertensive: [
    { kind: "metric", measurementType: "BLOOD_PRESSURE_SYS" },
    { kind: "metric", measurementType: "BLOOD_PRESSURE_DIA" },
  ],
  antidiabetic: [{ kind: "metric", measurementType: "BLOOD_GLUCOSE" }],
  glp1: [
    { kind: "metric", measurementType: "WEIGHT" },
    { kind: "metric", measurementType: "BLOOD_GLUCOSE" },
  ],
  // Lipid-modifiers (statins et al.) are monitored on LDL — a lab analyte.
  statin: [{ kind: "lab", analyte: "LDL", label: "LDL cholesterol" }],
  // Thyroid therapy is titrated against TSH — a lab analyte.
  thyroid: [{ kind: "lab", analyte: "TSH", label: "TSH" }],
  // Supplements are tracked against their own marker.
  vitamin_d: [
    { kind: "lab", analyte: "Vitamin D", label: "Vitamin D (25-OH)" },
  ],
  iron: [{ kind: "lab", analyte: "Ferritin", label: "Ferritin" }],
} as const;

/**
 * WHO ATC class-prefix → efficacy class. Prefix-level ONLY (the class the
 * substance belongs to), never a specific-product claim. Longer prefixes are
 * tested first so `A10BJ` (GLP-1/GIP agonists) wins over the `A10` fallback.
 * The prefix is upper-cased + validated against the `atcCode` shape before use.
 */
const ATC_PREFIX_CLASS: ReadonlyArray<readonly [string, EfficacyMedClass]> = [
  // Antidiabetics: GLP-1 / GIP agonists move glucose AND weight; the rest of
  // A10 (metformin, sulfonylureas, SGLT2, DPP-4, insulin) move glucose.
  ["A10BJ", "glp1"],
  ["A10", "antidiabetic"],
  // Cardiovascular: antihypertensives (C02 other, C03 diuretics, C07 beta
  // blockers, C08 CCB, C09 ACE/ARB) → blood pressure.
  ["C02", "antihypertensive"],
  ["C03", "antihypertensive"],
  ["C07", "antihypertensive"],
  ["C08", "antihypertensive"],
  ["C09", "antihypertensive"],
  // Lipid-modifying agents → LDL.
  ["C10", "statin"],
  // Thyroid therapy → TSH.
  ["H03A", "thyroid"],
  // Vitamin D / analogues (A11CC) and vitamin-D-only combos (A11CB).
  ["A11CC", "vitamin_d"],
  ["A11CB", "vitamin_d"],
  // Iron preparations (oral B03AA/AB/AD/AE, parenteral B03AC).
  ["B03A", "iron"],
];

const ATC_CODE_RE = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;

/** Whole-word name needles for the lab classes (metric classes stay above). */
const STATIN_NEEDLES: readonly string[] = [
  "atorvastatin",
  "simvastatin",
  "rosuvastatin",
  "pravastatin",
  "fluvastatin",
  "lovastatin",
  "pitavastatin",
  "ezetimibe",
];
const THYROID_NEEDLES: readonly string[] = [
  "levothyroxine",
  "liothyronine",
  "thyroxine",
  "euthyrox",
];
const VITAMIN_D_NEEDLES: readonly string[] = [
  "cholecalciferol",
  "colecalciferol",
  "ergocalciferol",
  "calcifediol",
  "calcitriol",
];
const IRON_NEEDLES: readonly string[] = [
  "ferrous",
  "ferric",
  "iron bisglycinate",
];

/** Resolve a med's efficacy class from its ATC prefix, or `null`. */
function classFromAtc(
  atcCode: string | null | undefined,
): EfficacyMedClass | null {
  if (!atcCode) return null;
  const code = atcCode.trim().toUpperCase();
  if (!ATC_CODE_RE.test(code)) return null;
  for (const [prefix, cls] of ATC_PREFIX_CLASS) {
    if (code.startsWith(prefix)) return cls;
  }
  return null;
}

/** Resolve a med's efficacy class from its name (metric + lab needles). */
function classFromName(
  name: string,
  treatmentClass?: string | null,
): EfficacyMedClass | null {
  // Metric classes stay authoritative through the existing inferer.
  const metricClass = inferMedTargetClass(name, treatmentClass);
  if (metricClass) return metricClass;

  const normalised = normaliseName(name);
  if (!normalised) return null;
  if (STATIN_NEEDLES.some((n) => containsWord(normalised, n))) return "statin";
  if (THYROID_NEEDLES.some((n) => containsWord(normalised, n)))
    return "thyroid";
  if (VITAMIN_D_NEEDLES.some((n) => containsWord(normalised, n))) {
    return "vitamin_d";
  }
  if (IRON_NEEDLES.some((n) => containsWord(normalised, n))) return "iron";
  return null;
}

/** The tier a target list was resolved through (provenance for the DTO/UI). */
export type MedTargetTier = "atc" | "name";

export interface ResolvedMedTargets {
  cls: EfficacyMedClass;
  tier: MedTargetTier;
  targets: readonly MedTarget[];
}

/**
 * Resolve the derived (non-override) efficacy targets for a medication:
 * ATC class-prefix FIRST (the guideline-native class key), then whole-word
 * name inference. Returns `null` when no class is confidently known — the
 * caller then falls back to the user's own explicit pick (tier 1, persisted)
 * or the "track this against…" chooser. Never guesses a target.
 *
 * Tier 1 (user override) is NOT resolved here — it is persisted and applied by
 * the server efficacy builder, which layers it on top of this derived result.
 */
export function resolveMedicationTargets(med: {
  name: string;
  treatmentClass?: string | null;
  atcCode?: string | null;
}): ResolvedMedTargets | null {
  const viaAtc = classFromAtc(med.atcCode);
  if (viaAtc) {
    return { cls: viaAtc, tier: "atc", targets: EFFICACY_TARGETS[viaAtc] };
  }
  const viaName = classFromName(med.name, med.treatmentClass);
  if (viaName) {
    return { cls: viaName, tier: "name", targets: EFFICACY_TARGETS[viaName] };
  }
  return null;
}

/** The ordered target list for an efficacy class (primary first). */
export function targetsForEfficacyClass(
  cls: EfficacyMedClass,
): readonly MedTarget[] {
  return EFFICACY_TARGETS[cls];
}
