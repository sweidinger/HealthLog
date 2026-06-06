/**
 * v1.15.0 — the seeded cycle-symptom catalog, mirrored client-side.
 *
 * The keys are fixed at the migration seed (0129). The `key` is the
 * snake_case DB key the day-log write resolves against; the `labelKey` is
 * the camelCase i18n leaf under `cycle.symptom.*`; the `icon` is the
 * Lucide name from the seed. Keep this in lockstep with the seed in
 * `prisma/migrations/0129_v1150_cycle_symptom_taxonomy/migration.sql` and
 * the `cycle.symptom.*` / `cycle.symptomCategory.*` i18n leaves.
 *
 * v1.15.1 layers per-user custom symptoms on top (the `custom` category,
 * seeded by migration 0134): the log-day sheet fetches them from
 * `/api/cycle/symptoms/custom` and merges them into this seeded grid. They
 * are NOT in this static catalog — their labels are user free text held
 * encrypted at rest, resolved server-side, never an i18n key.
 */
import {
  Activity,
  BatteryLow,
  Brain,
  CircleDot,
  CircleSlash,
  Cookie,
  Drama,
  Droplet,
  Flame,
  Frown,
  Heart,
  HeartPulse,
  MoonStar,
  PersonStanding,
  Snowflake,
  Soup,
  Toilet,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface CycleSymptom {
  /** snake_case DB key — the value sent in `symptoms[].key`. */
  key: string;
  /** i18n leaf under `cycle.symptom.*`. */
  labelKey: string;
  icon: LucideIcon;
}

export interface CycleSymptomCategory {
  key: string;
  /** i18n leaf under `cycle.symptomCategory.*`. */
  labelKey: string;
  icon: LucideIcon;
  symptoms: CycleSymptom[];
}

export const CYCLE_SYMPTOM_CATALOG: CycleSymptomCategory[] = [
  {
    key: "physical",
    labelKey: "cycle.symptomCategory.physical",
    icon: Activity,
    symptoms: [
      { key: "cramps", labelKey: "cycle.symptom.cramps", icon: Zap },
      { key: "headache", labelKey: "cycle.symptom.headache", icon: Brain },
      { key: "bloating", labelKey: "cycle.symptom.bloating", icon: CircleDot },
      { key: "acne", labelKey: "cycle.symptom.acne", icon: Droplet },
      {
        key: "breast_tenderness",
        labelKey: "cycle.symptom.breastTenderness",
        icon: HeartPulse,
      },
      { key: "fatigue", labelKey: "cycle.symptom.fatigue", icon: BatteryLow },
      {
        key: "back_pain",
        labelKey: "cycle.symptom.backPain",
        icon: PersonStanding,
      },
      { key: "insomnia", labelKey: "cycle.symptom.insomnia", icon: MoonStar },
    ],
  },
  {
    key: "emotional",
    labelKey: "cycle.symptomCategory.emotional",
    icon: Heart,
    symptoms: [
      { key: "libido_high", labelKey: "cycle.symptom.libidoHigh", icon: Flame },
      {
        key: "libido_low",
        labelKey: "cycle.symptom.libidoLow",
        icon: Snowflake,
      },
      { key: "mood_swings", labelKey: "cycle.symptom.moodSwings", icon: Drama },
    ],
  },
  {
    key: "digestive",
    labelKey: "cycle.symptomCategory.digestive",
    icon: Soup,
    symptoms: [
      {
        key: "food_cravings",
        labelKey: "cycle.symptom.foodCravings",
        icon: Cookie,
      },
      { key: "nausea", labelKey: "cycle.symptom.nausea", icon: Frown },
      { key: "diarrhea", labelKey: "cycle.symptom.diarrhea", icon: Toilet },
      {
        key: "constipation",
        labelKey: "cycle.symptom.constipation",
        icon: CircleSlash,
      },
    ],
  },
];
