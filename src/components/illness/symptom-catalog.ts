/**
 * v1.18.1 — the seeded illness-symptom catalog, mirrored client-side.
 *
 * The keys are fixed at the migration seed (0171). The `key` is the
 * snake_case DB key the day-log write resolves against; the `labelKey` is
 * the i18n leaf under `illness.symptom.*`; the `icon` is the Lucide name
 * from the seed. Keep this in lockstep with the seed in
 * `prisma/migrations/0171_v1181_illness_episode/migration.sql` and the
 * `illness.symptom.*` i18n leaves.
 *
 * The set is Jackson / WURSS-derived (~8 cardinal upper-respiratory + viral
 * symptoms, 0–3 severity). Fever lives on the day row (`feverC`), not as a
 * symptom chip; functional impact is a separate slider.
 */
import {
  BatteryLow,
  Brain,
  Droplets,
  Flame,
  Megaphone,
  PersonStanding,
  Waves,
  Wind,
  type LucideIcon,
} from "lucide-react";

export interface IllnessSymptom {
  /** snake_case DB key — the value sent in `symptoms[].key`. */
  key: string;
  /** i18n leaf under `illness.symptom.*`. */
  labelKey: string;
  icon: LucideIcon;
}

export const ILLNESS_SYMPTOM_CATALOG: IllnessSymptom[] = [
  { key: "runny_nose", labelKey: "illness.symptom.runnyNose", icon: Droplets },
  { key: "stuffy_nose", labelKey: "illness.symptom.stuffyNose", icon: Wind },
  { key: "sneezing", labelKey: "illness.symptom.sneezing", icon: Waves },
  { key: "sore_throat", labelKey: "illness.symptom.soreThroat", icon: Flame },
  { key: "cough", labelKey: "illness.symptom.cough", icon: Megaphone },
  { key: "headache", labelKey: "illness.symptom.headache", icon: Brain },
  {
    key: "body_aches",
    labelKey: "illness.symptom.bodyAches",
    icon: PersonStanding,
  },
  { key: "fatigue", labelKey: "illness.symptom.fatigue", icon: BatteryLow },
];
