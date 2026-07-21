import type { DrugProfile } from "./types";

/**
 * Stimulant / ADHD drug profile — Stage A of the ADHS tuning.
 *
 * Authored 2026-07-21 by extracting the Lisdexamfetamine package leaflet
 * (Lisdex Aristo 10 mg/ml). This is the prototype's "the app knows the drug"
 * content: what it is for, the daily-relevant side effects to check, and the
 * ADHD target symptoms to rate. Replaceable by an ePI/FHIR-sourced profile
 * later without changing the shape.
 *
 * Side-effect set is the focused daily subset (PIL very-common + common,
 * self-reportable, plus the clinically important afternoon rebound). The PIL's
 * rarer effects and objectively-measured ones (weight, blood pressure) are out
 * of the yes/no daily set by design.
 */
export const STIMULANT_ADHD_PROFILE: DrugProfile = {
  id: "stimulant-adhd",
  version: "1.0.0",
  treatmentClass: "STIMULANT",
  atcPrefix: "N06BA",
  source: {
    type: "PIL",
    product:
      "Lisdex Aristo 10 mg/ml Lösung zum Einnehmen (Lisdexamfetamindimesilat)",
    url: "https://gebrauchsinformation4-0.de/pil/lisdex-aristo-10-mgml-loesung-zum-einnehmen~39d0019a-673b-5d7b-9204-9aeba083b256/lisdex-aristo-10-mgml-loesung-zum-einnehmen~1f4f5239-ccab-59e4-9a08-8ceb1684a971",
    extractedAt: "2026-07-21",
    method:
      "AI extraction from the package leaflet (prototype; hybrid — replaceable by an ePI/FHIR source later)",
  },
  indication: {
    de: "Behandlung von ADHS als Teil eines umfassenden Behandlungsprogramms.",
    en: "Treatment of ADHD as part of a comprehensive treatment programme.",
  },
  dosing: {
    note: "Physician-directed titration. Typically 20–30 mg in the morning before breakfast, titrated up to a maximum of 70 mg. The app mirrors the prescribed plan and never suggests doses.",
    startMgTypical: 30,
    maxMg: 70,
    timeOfDay: "morning",
  },
  // Labels resolve via i18n: medications.sideEffects.entries.<camelCaseEntry>.
  sideEffects: [
    { entry: "REDUCED_APPETITE", frequency: "very_common" },
    { entry: "INSOMNIA", frequency: "very_common" },
    { entry: "DRY_MOUTH", frequency: "very_common" },
    { entry: "HEADACHE", frequency: "very_common" },
    { entry: "IRRITABILITY", frequency: "common" },
    { entry: "ANXIETY", frequency: "common" },
    { entry: "MOOD_SWINGS", frequency: "common" },
    { entry: "RESTLESSNESS", frequency: "common" },
    { entry: "FATIGUE", frequency: "common" },
    { entry: "TREMOR", frequency: "common" },
    { entry: "TICS", frequency: "common" },
    { entry: "PALPITATIONS", frequency: "common" },
    { entry: "SWEATING", frequency: "common" },
    { entry: "BRUXISM", frequency: "common" },
    { entry: "AFTERNOON_REBOUND", frequency: "clinical" },
  ],
  targetSymptoms: [
    {
      key: "focus",
      labelDe: "Fokus / Konzentration",
      labelEn: "Focus / concentration",
      higherIsBetter: true,
    },
    {
      key: "distractibility",
      labelDe: "Ablenkbarkeit",
      labelEn: "Distractibility",
      higherIsBetter: false,
    },
    {
      key: "impulsivity",
      labelDe: "Impulsivität",
      labelEn: "Impulsivity",
      higherIsBetter: false,
    },
    {
      key: "task_initiation",
      labelDe: "Anpacken / Aufgaben starten",
      labelEn: "Task initiation",
      higherIsBetter: true,
    },
    {
      key: "emotional_regulation",
      labelDe: "Emotionale Regulation",
      labelEn: "Emotional regulation",
      higherIsBetter: true,
    },
    {
      key: "inner_restlessness",
      labelDe: "Innere Unruhe",
      labelEn: "Inner restlessness",
      higherIsBetter: false,
    },
  ],
  targetSymptomScale: { min: 1, max: 10 },
  // Stage B.2 — when (relative to the morning intake) the check-in is most
  // informative to record: ~3 h in, the drug is active ("is it working +
  // early side effects"); ~9 h in catches the late-afternoon rebound of a
  // long-acting morning stimulant. These are documentation-timing offsets,
  // not a pharmacokinetic claim or a dose recommendation; the user opts in
  // and can ignore any nudge.
  effectWindow: {
    effectOffsetHours: 3,
    reboundOffsetHours: 9,
  },
};
