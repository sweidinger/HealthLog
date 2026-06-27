/**
 * v1.18.1 — static seed catalog of common blood/lab biomarkers.
 *
 * This is NOT a DB table. It is a curated list offered at the add step
 * ("pick a common marker, or create your own") so a self-hoster does not
 * type a marker definition from scratch. Selecting a seed pre-fills the
 * inline definition form (canonical name, unit, suggested reference bounds)
 * which the user then accepts or overrides before it becomes a real,
 * user-scoped `Biomarker` row.
 *
 * The suggested ranges are EDITABLE DEFAULTS, never gospel — reference
 * windows vary by lab, sex, and age. The display name is localised via the
 * `labs.catalog.<slug>` i18n key; the EN slug is the stable identity (mirrors
 * the Insights slug/alias pattern). Units stay literal (mg/dL etc. are not
 * translated).
 *
 * Source ranges: common adult fasting reference windows (US conventional
 * units where the metric/SI split matters). Presented as starting points.
 */

export interface BiomarkerSeed {
  /** Stable EN identity; the `labs.catalog.<slug>` i18n key resolves the name. */
  slug: string;
  /** Panel grouping key; the `labs.catalog.panel.<panel>` i18n key labels it. */
  panel: string;
  /** Canonical unit for every reading against this marker. */
  unit: string;
  /** Suggested lower bound (editable default), or null when open-ended. */
  lowerBound: number | null;
  /** Suggested upper bound (editable default), or null when open-ended. */
  upperBound: number | null;
}

export const BIOMARKER_CATALOG: readonly BiomarkerSeed[] = [
  // Lipids
  {
    slug: "total-cholesterol",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 200,
  },
  {
    slug: "ldl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 116,
  },
  {
    slug: "hdl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: 40,
    upperBound: null,
  },
  {
    slug: "triglycerides",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 150,
  },
  // Glucose metabolism
  {
    slug: "fasting-glucose",
    panel: "glucose",
    unit: "mg/dL",
    lowerBound: 70,
    upperBound: 100,
  },
  {
    slug: "hba1c",
    panel: "glucose",
    unit: "%",
    lowerBound: null,
    upperBound: 5.7,
  },
  // Thyroid
  {
    slug: "tsh",
    panel: "thyroid",
    unit: "mIU/L",
    lowerBound: 0.4,
    upperBound: 4,
  },
  {
    slug: "ft3",
    panel: "thyroid",
    unit: "pg/mL",
    lowerBound: 2.3,
    upperBound: 4.2,
  },
  {
    slug: "ft4",
    panel: "thyroid",
    unit: "ng/dL",
    lowerBound: 0.8,
    upperBound: 1.8,
  },
  // Iron
  {
    slug: "ferritin",
    panel: "iron",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 400,
  },
  {
    slug: "transferrin-saturation",
    panel: "iron",
    unit: "%",
    lowerBound: 20,
    upperBound: 50,
  },
  // Vitamins
  {
    slug: "vitamin-d",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 100,
  },
  {
    slug: "vitamin-b12",
    panel: "vitamins",
    unit: "pg/mL",
    lowerBound: 200,
    upperBound: 900,
  },
  {
    slug: "folate",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 3,
    upperBound: 20,
  },
  // Inflammation
  {
    slug: "hs-crp",
    panel: "inflammation",
    unit: "mg/L",
    lowerBound: null,
    upperBound: 3,
  },
  // Renal
  {
    slug: "creatinine",
    panel: "renal",
    unit: "mg/dL",
    lowerBound: 0.6,
    upperBound: 1.3,
  },
  {
    slug: "egfr",
    panel: "renal",
    unit: "mL/min/1.73m²",
    lowerBound: 90,
    upperBound: null,
  },
  // Liver
  {
    slug: "alt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ast",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ggt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 55,
  },
  // Electrolytes
  {
    slug: "sodium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 135,
    upperBound: 145,
  },
  {
    slug: "potassium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 3.5,
    upperBound: 5.1,
  },
  // Blood count
  {
    slug: "hemoglobin",
    panel: "bloodCount",
    unit: "g/dL",
    lowerBound: 12,
    upperBound: 17.5,
  },
  {
    slug: "hematocrit",
    panel: "bloodCount",
    unit: "%",
    lowerBound: 36,
    upperBound: 50,
  },
  {
    slug: "wbc",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 4,
    upperBound: 11,
  },
  {
    slug: "platelets",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 150,
    upperBound: 400,
  },
] as const;

/** The set of panel keys present in the catalog, in display order. */
export const BIOMARKER_PANELS = [
  "lipids",
  "glucose",
  "thyroid",
  "iron",
  "vitamins",
  "inflammation",
  "renal",
  "liver",
  "electrolytes",
  "bloodCount",
] as const;
