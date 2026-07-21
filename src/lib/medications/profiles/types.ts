import type { MedicationSideEffectEntry } from "@/generated/prisma/client";

/**
 * Drug profiles — the content layer that makes HealthLog "know" what a
 * medication is for and which effects to watch, so the medication surfaces can
 * be tailored (side-effect check-in set, target-symptom set) instead of asking
 * the user to fill a blank form.
 *
 * A profile is IMPORTABLE, VERSIONED data, not hard-wired UI. For the prototype
 * a profile is authored once by extracting the package leaflet (PIL); the same
 * shape can later be populated from an ePI/FHIR source. Nothing here is a
 * dosing recommendation — the profile is descriptive (indication + expected
 * effects); the titration plan always comes from the prescriber (CLAUDE.md §1).
 *
 * Side-effect LABELS are NOT stored here — they come from i18n
 * (`medications.sideEffects.entries.*`) keyed by the enum entry, so the profile
 * stays language-neutral and single-source. Target-symptom labels ARE carried
 * here because they are new content this profile introduces (they seed the
 * per-user custom metrics in a later stage).
 */

/** Leaflet frequency band; `clinical` = not a leaflet term but a titration-relevant signal (e.g. afternoon rebound). */
export type SideEffectFrequency =
  "very_common" | "common" | "uncommon" | "rare" | "clinical";

export interface DrugProfileSideEffect {
  /** A canonical taxonomy entry (compile-checked against the Prisma enum). */
  entry: MedicationSideEffectEntry;
  frequency: SideEffectFrequency;
}

export interface DrugProfileTargetSymptom {
  /** Stable slug used as the seeded custom-metric identity, e.g. "focus". */
  key: string;
  labelDe: string;
  labelEn: string;
  /**
   * Trend direction only — the app shows the trend, never a good/bad verdict.
   * true: a higher rating is the desired direction (e.g. focus); false: lower
   * is desired (e.g. impulsivity).
   */
  higherIsBetter: boolean;
}

export interface DrugProfileSource {
  type: "PIL" | "ePI" | "manual";
  product: string;
  url?: string;
  extractedAt: string;
  method: string;
}

export interface DrugProfile {
  id: string;
  version: string;
  /** `Medication.treatmentClass` value this profile applies to. */
  treatmentClass: string;
  atcPrefix: string;
  source: DrugProfileSource;
  indication: { de: string; en: string };
  dosing: {
    /** Descriptive note; the app never suggests doses. */
    note: string;
    startMgTypical?: number;
    maxMg?: number;
    timeOfDay?: "morning" | "midday" | "evening";
  };
  /** Focused daily-check-in side-effect set (labels via i18n by entry). */
  sideEffects: readonly DrugProfileSideEffect[];
  targetSymptoms: readonly DrugProfileTargetSymptom[];
  targetSymptomScale: { min: number; max: number };
  /**
   * Optional effect-window timing (Stage B.2) — WHEN, relative to the
   * earliest daily intake, the guided check-in is most informative to
   * record, so the reminder cron can nudge inside the drug's active window
   * instead of at a fixed clock time. Both are offsets in hours from the
   * intake slot.
   *
   * This is reminder-TIMING metadata for documentation, NOT a dosing or
   * pharmacokinetic claim and never a dose recommendation (CLAUDE.md §1):
   * a class without it simply gets no effect-window reminder.
   */
  effectWindow?: {
    /** Hours after intake for the first ("is it working yet?") check-in nudge. */
    effectOffsetHours: number;
    /** Hours after intake for the afternoon-rebound check-in nudge. */
    reboundOffsetHours: number;
  };
}
