/**
 * The assessment surfaces the tone harness grades, and the committed fixture
 * arguments it builds them from.
 *
 * One registry, so a NEW assessment surface is one entry away from being
 * covered — and so a surface that is added without an entry is visible as a
 * gap rather than as silence. The count assertion in the harness test is the
 * thing that makes that true: adding a `get*SystemPrompt` module without
 * registering it here fails the suite.
 *
 * The fixture arguments are deliberately inert placeholders. These rules grade
 * the INSTRUCTION text, not the snapshot, so a realistic snapshot would only
 * add noise (and a real-looking one would put fabricated health figures in the
 * repo). The snapshot token is a literal.
 */
import type { Locale } from "@/lib/i18n/config";

import {
  getBiomarkerSystemPrompt,
  getBiomarkerUserPrompt,
} from "@/lib/ai/prompts/biomarker";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import { getMoodSystemPrompt, getMoodUserPrompt } from "@/lib/ai/prompts/mood";
import {
  getPulseSystemPrompt,
  getPulseUserPrompt,
} from "@/lib/ai/prompts/pulse";
import {
  getWeightSystemPrompt,
  getWeightUserPrompt,
} from "@/lib/ai/prompts/weight";
import {
  getWorkoutInsightSystemPrompt,
  getWorkoutInsightUserPrompt,
} from "@/lib/ai/prompts/workout-insight";
import type { MetricStatusMeta } from "@/lib/insights/metric-status-registry";

/** Inert snapshot placeholder — the rules never read it. */
const SNAPSHOT = "{SNAPSHOT}";
const TODAY = "2026-07-18";

/**
 * A representative opener hint. Passed to every surface that accepts one so
 * the harness grades the prompt in the shape production actually sends, hint
 * included — a surface that silently drops the hint arg still has to satisfy
 * the meaning-first rules on its own instruction text.
 */
const OPENER_HINT =
  "Open with the overall read in plain words, then bring in the number as support — not number-first.";

const META: MetricStatusMeta = {
  key: "STEP_COUNT",
  displayName: "Steps",
  unit: "steps",
  direction: "higher-better",
  archetype: "activity-fitness",
  normalRange: { low: 7000, high: 12000 },
} as unknown as MetricStatusMeta;

export interface AssessmentSurface {
  /** Stable id — appears in the failure message. */
  name: string;
  system: (locale: Locale) => string;
  user: (locale: Locale) => string;
}

export const ASSESSMENT_SURFACES: readonly AssessmentSurface[] = [
  {
    name: "blood-pressure",
    system: getBloodPressureSystemPrompt,
    user: (l) =>
      getBloodPressureUserPrompt(
        SNAPSHOT,
        TODAY,
        l,
        undefined,
        undefined,
        OPENER_HINT,
      ),
  },
  {
    name: "weight",
    system: getWeightSystemPrompt,
    user: (l) =>
      getWeightUserPrompt(
        SNAPSHOT,
        TODAY,
        l,
        undefined,
        undefined,
        OPENER_HINT,
      ),
  },
  {
    name: "bmi",
    system: getBmiSystemPrompt,
    user: (l) =>
      getBmiUserPrompt(SNAPSHOT, TODAY, l, undefined, undefined, OPENER_HINT),
  },
  {
    name: "pulse",
    system: getPulseSystemPrompt,
    user: (l) =>
      getPulseUserPrompt(SNAPSHOT, TODAY, l, undefined, undefined, OPENER_HINT),
  },
  {
    name: "mood",
    system: getMoodSystemPrompt,
    user: (l) =>
      getMoodUserPrompt(SNAPSHOT, TODAY, l, undefined, undefined, OPENER_HINT),
  },
  {
    name: "medication-compliance",
    system: getMedicationComplianceSystemPrompt,
    user: (l) =>
      getMedicationComplianceUserPrompt(
        SNAPSHOT,
        TODAY,
        l,
        undefined,
        undefined,
        OPENER_HINT,
      ),
  },
  {
    name: "general-status",
    system: getGeneralStatusSystemPrompt,
    user: (l) =>
      getGeneralStatusUserPrompt(
        SNAPSHOT,
        TODAY,
        l,
        undefined,
        undefined,
        OPENER_HINT,
      ),
  },
  {
    name: "metric-archetype",
    system: (l) => getMetricArchetypeSystemPrompt(META, l),
    user: (l) =>
      getMetricArchetypeUserPrompt(
        META,
        SNAPSHOT,
        TODAY,
        l,
        undefined,
        undefined,
        undefined,
        OPENER_HINT,
      ),
  },
  {
    // The surface this harness was built around: it composed its prompt inline,
    // skipped the shared base, took no opener hint, and instructed the model to
    // state the value first.
    name: "biomarker",
    system: (l) => getBiomarkerSystemPrompt("Marker", l),
    user: (l) => getBiomarkerUserPrompt(SNAPSHOT, TODAY, l, OPENER_HINT),
  },
  {
    // Describes one recorded session rather than a metric's trajectory, but it
    // composes the same base body and owes the same opening contract — so it
    // is graded here rather than given its own dialect.
    name: "workout-insight",
    system: getWorkoutInsightSystemPrompt,
    user: (l) => getWorkoutInsightUserPrompt(SNAPSHOT, TODAY, l, OPENER_HINT),
  },
];
