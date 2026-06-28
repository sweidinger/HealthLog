/**
 * v1.18.8 — common lab biomarker → LOINC + canonical UCUM mapping.
 *
 * The lab-result `analyte` and `unit` are user free-text (no closed enum), so
 * the FHIR exporter has historically emitted a text-only `code` with a
 * display-only `unit` — honest about what it could validate. This module
 * closes the gap WITHOUT over-asserting: a curated map of the COMMON
 * biomarkers the app and docs surface (the demo's 9-biomarker panel + the
 * usual lipid / metabolic / liver / kidney / inflammation set). An analyte
 * that resolves here gets a real LOINC `coding` ALONGSIDE the user's
 * `code.text`, and the canonical UCUM `code` on the value WHEN the recorded
 * unit matches (or normalises to) the mapped canonical symbol. An analyte
 * that does NOT resolve keeps the exact pre-v1.18.8 text-only + unit-display
 * behaviour — no fabricated terminology.
 *
 * Conservative by design: only biomarkers whose LOINC term is well-established
 * are included. When in doubt, a biomarker is left OUT (text-only stays the
 * honest default) rather than guessed.
 *
 * Systems:
 *   LOINC — http://loinc.org
 *   UCUM  — http://unitsofmeasure.org
 *
 * FORWARD-COMPAT (v1.19.0 Biomarker catalog): the schema has a planned
 * user-scoped `Biomarker` catalog (`LabResult.biomarkerId`, NULL today). Once
 * a backfill links rows to a canonical analyte + unit, the resolved canonical
 * name should drive this lookup AHEAD of the raw free-text. `resolveLabCoding`
 * therefore accepts an optional `canonicalName` (the catalog's resolved name)
 * which takes precedence over the free-text `analyte`; the lab DTO does not
 * yet carry that field, so the call site passes only `analyte` today. When the
 * DTO gains a `biomarkerCanonicalName` (or similar), thread it in — no other
 * change to this module is required.
 */

import { LOINC_SYSTEM, UCUM_SYSTEM } from "@/lib/fhir/loinc-map";

export { LOINC_SYSTEM, UCUM_SYSTEM };

/** A curated biomarker → LOINC + canonical-UCUM entry. */
export interface LabLoincMapping {
  loinc: string;
  display: string;
  /** Canonical UCUM symbol for this biomarker's value. */
  ucum: string;
}

/**
 * Normalise an analyte / unit string to a lookup key: lower-case, strip every
 * character that is not a letter or digit. So "LDL-C", "LDL Cholesterol",
 * "ldl_c" all fold to `ldlc`-ish keys; the alias table below pins the exact
 * variants the app and German users actually type onto a single canonical key.
 */
export function normaliseLabKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Curated map keyed by the CANONICAL normalised analyte key. Aliases (below)
 * fold the many ways a user can spell a biomarker onto these keys. Each entry
 * is a well-established LOINC term with the conventional canonical UCUM unit.
 */
const LAB_LOINC_BY_KEY: Record<string, LabLoincMapping> = {
  hba1c: {
    loinc: "4548-4",
    display: "Hemoglobin A1c/Hemoglobin.total in Blood",
    ucum: "%",
  },
  ldlc: {
    loinc: "18262-6",
    display: "Cholesterol in LDL [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  hdlc: {
    loinc: "2085-9",
    display: "Cholesterol in HDL [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  cholesterol: {
    loinc: "2093-3",
    display: "Cholesterol [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  triglycerides: {
    loinc: "2571-8",
    display: "Triglyceride [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  ferritin: {
    loinc: "2276-4",
    display: "Ferritin [Mass/volume] in Serum or Plasma",
    ucum: "ug/L",
  },
  tsh: {
    loinc: "3016-3",
    display: "Thyrotropin [Units/volume] in Serum or Plasma",
    ucum: "m[IU]/L",
  },
  vitamind: {
    loinc: "1989-3",
    display:
      "25-hydroxyvitamin D2+25-hydroxyvitamin D3 [Mass/volume] in Serum or Plasma",
    ucum: "ng/mL",
  },
  creatinine: {
    loinc: "2160-0",
    display: "Creatinine [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  egfr: {
    loinc: "33914-3",
    display:
      "Glomerular filtration rate/1.73 sq M.predicted by Creatinine-based formula (MDRD)",
    ucum: "mL/min/{1.73_m2}",
  },
  alt: {
    loinc: "1742-6",
    display:
      "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  ast: {
    loinc: "1920-8",
    display:
      "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  crp: {
    loinc: "1988-5",
    display: "C reactive protein [Mass/volume] in Serum or Plasma",
    ucum: "mg/L",
  },
  glucosefasting: {
    loinc: "1558-6",
    display: "Fasting glucose [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  hemoglobin: {
    loinc: "718-7",
    display: "Hemoglobin [Mass/volume] in Blood",
    ucum: "g/dL",
  },
  // ── v1.25 — longevity lab panel additions (loinc.org confirmed this pass) ──
  apob: {
    loinc: "1884-6",
    display: "Apolipoprotein B [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  lpa: {
    loinc: "43583-4",
    display: "Lipoprotein a [Moles/volume] in Serum or Plasma",
    ucum: "nmol/L",
  },
  hscrp: {
    loinc: "30522-7",
    display:
      "C reactive protein [Mass/volume] in Serum or Plasma by High sensitivity method",
    ucum: "mg/L",
  },
  ggt: {
    loinc: "2324-2",
    display:
      "Gamma glutamyl transferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  fastinginsulin: {
    loinc: "27873-9",
    display: "Insulin [Units/volume] in Serum or Plasma --fasting",
    ucum: "u[IU]/mL",
  },
  // NOTE(NEEDS-VERIFY): the RBC omega-3 index has no confirmed LOINC this pass
  // — it intentionally falls back to a local text-only concept on export.
};

/**
 * Alias → canonical key. The LEFT side is the normalised form of a name a user
 * (EN or DE) might type; the RIGHT side is a key in `LAB_LOINC_BY_KEY`. Every
 * canonical key is also implicitly its own alias (looked up directly first).
 * Keep the right side honest — only fold a synonym when it unambiguously names
 * the same analyte.
 */
const LAB_ALIASES: Record<string, string> = {
  // HbA1c
  a1c: "hba1c",
  glycatedhemoglobin: "hba1c",
  glycohemoglobin: "hba1c",
  hbalc: "hba1c",
  // LDL
  ldl: "ldlc",
  ldlcholesterol: "ldlc",
  ldlchol: "ldlc",
  // HDL
  hdl: "hdlc",
  hdlcholesterol: "hdlc",
  hdlchol: "hdlc",
  // Total cholesterol
  totalcholesterol: "cholesterol",
  cholesterintotal: "cholesterol",
  gesamtcholesterin: "cholesterol",
  chol: "cholesterol",
  // Triglycerides
  triglyceride: "triglycerides",
  trig: "triglycerides",
  triglyceride2: "triglycerides",
  tg: "triglycerides",
  // TSH
  thyrotropin: "tsh",
  thyroidstimulatinghormone: "tsh",
  // Vitamin D
  vitd: "vitamind",
  vit25ohd: "vitamind",
  "25ohd": "vitamind",
  "25hydroxyvitamind": "vitamind",
  vitamind3: "vitamind",
  // Creatinine
  kreatinin: "creatinine",
  creat: "creatinine",
  // eGFR
  gfr: "egfr",
  estimatedgfr: "egfr",
  // ALT
  gpt: "alt",
  alat: "alt",
  alaninetransaminase: "alt",
  // AST
  got: "ast",
  asat: "ast",
  aspartatetransaminase: "ast",
  // CRP
  creactiveprotein: "crp",
  // Fasting glucose
  fastingglucose: "glucosefasting",
  glucosefast: "glucosefasting",
  nuchternglucose: "glucosefasting",
  // Hemoglobin
  haemoglobin: "hemoglobin",
  hb: "hemoglobin",
  hgb: "hemoglobin",
  hamoglobin: "hemoglobin",
  // ── v1.25 — longevity lab panel aliases ──
  apolipoproteinb: "apob",
  apolipoprotein: "apob",
  lipoproteina: "lpa",
  lpkleina: "lpa",
  hscrp: "hscrp",
  highsensitivitycrp: "hscrp",
  hochsensitivescrp: "hscrp",
  gammagt: "ggt",
  gammaglutamyltransferase: "ggt",
  ggtp: "ggt",
  fastinginsulin: "fastinginsulin",
  insulinfasting: "fastinginsulin",
  nuchterninsulin: "fastinginsulin",
};

/**
 * Canonical UCUM symbols that a recorded free-text unit may normalise to. The
 * LEFT is the normalised (lower-cased, punctuation-stripped) recorded unit;
 * the RIGHT is the canonical UCUM symbol. Used to decide whether the lab's
 * unit MATCHES the mapped biomarker's canonical UCUM so the UCUM `code` can be
 * stamped. A non-matching unit keeps the value's `unit` display only (no UCUM
 * `code`) — never a coerced value.
 */
const UNIT_NORMALISATION: Record<string, string> = {
  // percent
  "%": "%",
  pct: "%",
  percent: "%",
  // mg/dL family
  mgdl: "mg/dL",
  "mg/dl": "mg/dL",
  // mg/L
  mgl: "mg/L",
  "mg/l": "mg/L",
  // ng/mL
  ngml: "ng/mL",
  "ng/ml": "ng/mL",
  // ug/L (ferritin)
  ugl: "ug/L",
  "ug/l": "ug/L",
  "µg/l": "ug/L",
  "mcg/l": "ug/L",
  ngml2: "ng/mL",
  "ng/ml2": "ng/mL",
  // g/dL (hemoglobin)
  gdl: "g/dL",
  "g/dl": "g/dL",
  // U/L (enzymes)
  ul: "U/L",
  "u/l": "U/L",
  iul: "U/L",
  "iu/l": "U/L",
  // mIU/L (TSH)
  miul: "m[IU]/L",
  "miu/l": "m[IU]/L",
  uiuml: "m[IU]/L",
  "µiu/ml": "m[IU]/L",
  "uiu/ml": "m[IU]/L",
  // eGFR rate
  mlmin173m2: "mL/min/{1.73_m2}",
  "ml/min/1.73m2": "mL/min/{1.73_m2}",
  "ml/min/1.73sqm": "mL/min/{1.73_m2}",
};

/** Normalise a recorded unit string for canonical-UCUM matching. */
function normaliseUnit(unit: string): string {
  const trimmed = unit.trim();
  // Try the verbatim-lowercase form first (covers "mg/dL" → "mg/dl"), then the
  // punctuation-stripped form (covers "mg dl" / "mgdl"). Both routes resolve
  // through the same table so equivalent spellings collapse.
  const lower = trimmed.toLowerCase();
  if (UNIT_NORMALISATION[lower]) return UNIT_NORMALISATION[lower];
  const stripped = normaliseLabKey(trimmed);
  return UNIT_NORMALISATION[stripped] ?? trimmed;
}

/** The resolved coding for one lab result, or null when the analyte is unmapped. */
export interface ResolvedLabCoding {
  loinc: string;
  display: string;
  /**
   * Canonical UCUM symbol to stamp on the value, ONLY when the recorded unit
   * matches the mapped biomarker's canonical UCUM. Null when the unit does not
   * match (display-only `unit` is kept, no coerced UCUM `code`).
   */
  ucum: string | null;
}

/**
 * Resolve a lab result's LOINC coding + canonical UCUM.
 *
 * Precedence: the v1.19.0 catalog's resolved `canonicalName` (when the DTO
 * carries it — it does not today) wins over the raw free-text `analyte`. The
 * `unit` is matched against the mapped biomarker's canonical UCUM; only an
 * exact (post-normalisation) match yields a UCUM `code`.
 *
 * Returns null when the analyte does not resolve — the caller then keeps the
 * honest text-only + display-unit behaviour (no fabricated codes).
 */
export function resolveLabCoding(
  analyte: string,
  unit: string,
  canonicalName?: string | null,
): ResolvedLabCoding | null {
  const source =
    canonicalName && canonicalName.length > 0 ? canonicalName : analyte;
  const key = normaliseLabKey(source);
  const resolvedKey = LAB_LOINC_BY_KEY[key] ? key : LAB_ALIASES[key];
  if (!resolvedKey) return null;
  const mapping = LAB_LOINC_BY_KEY[resolvedKey];
  if (!mapping) return null;
  const ucum = normaliseUnit(unit) === mapping.ucum ? mapping.ucum : null;
  return { loinc: mapping.loinc, display: mapping.display, ucum };
}
