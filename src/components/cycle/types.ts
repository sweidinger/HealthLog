/**
 * v1.15.0 — client-side mirrors of the `/api/cycle/*` response DTOs
 * (ios-contract §2). These match `src/lib/cycle/dto.ts` +
 * `src/lib/cycle/engine-adapter.ts` field-for-field so the read hooks can
 * type the unwrapped `(await res.json()).data`.
 */

export type CyclePhase =
  | "MENSTRUAL"
  | "FOLLICULAR"
  | "OVULATORY"
  | "LUTEAL";

export type FlowLevel = "NONE" | "SPOTTING" | "LIGHT" | "MEDIUM" | "HEAVY";

export type OvulationTest =
  | "NEGATIVE"
  | "POSITIVE_LH_SURGE"
  | "ESTROGEN_SURGE"
  | "INDETERMINATE";

export type CervicalMucus =
  | "DRY"
  | "STICKY"
  | "CREAMY"
  | "WATERY"
  | "EGG_WHITE";

export type CycleGoal =
  | "GENERAL_HEALTH"
  | "AVOID_PREGNANCY"
  | "TRYING_TO_CONCEIVE"
  | "PERIMENOPAUSE"
  | "OFF";

export interface CalendarDay {
  date: string;
  phase: CyclePhase | null;
  isPredictedPeriod: boolean;
  isFertileWindow: boolean;
  isPredictedOvulation: boolean;
  isPeriodLogged: boolean;
  flow: string | null;
  hasSymptoms: boolean;
  confidence: number;
}

export interface CyclePrediction {
  method: string;
  nextPeriodStart: string;
  nextPeriodStartLow: string;
  nextPeriodStartHigh: string;
  fertileWindowStart: string | null;
  fertileWindowEnd: string | null;
  predictedOvulation: string | null;
  confidence: number;
  cyclesObserved: number;
  stillLearning: boolean;
  disclaimer: string;
}

export interface CalendarResponse {
  profile: {
    goal: CycleGoal;
    rawChartMode: boolean;
    predictionEnabled: boolean;
    cyclesObserved: number;
  };
  prediction: CyclePrediction | null;
  days: CalendarDay[];
  meta: { generatedAt: string };
}

export interface MenstrualCycleDTO {
  id: string;
  startDate: string;
  endDate: string | null;
  periodEndDate: string | null;
  lengthDays: number | null;
  ovulationDate: string | null;
  ovulationConfirmed: boolean;
  isPredicted: boolean;
  syncVersion: number;
  updatedAt: string;
}

export interface CycleHistoryResponse {
  cycles: MenstrualCycleDTO[];
  stats: {
    avgLengthDays: number | null;
    lengthVariabilityDays: number | null;
    avgPeriodLengthDays: number | null;
    regularity: "REGULAR" | "IRREGULAR" | "LEARNING";
  };
}

export interface CycleProfileDTO {
  goal: CycleGoal;
  cycleTrackingEnabled: boolean;
  rawChartMode: boolean;
  predictionEnabled: boolean;
  discreetNotifications: boolean;
  sensitiveCategoryEncryption: boolean;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  updatedAt: string;
}

/** The day-log capture payload (subset of the API input we send from web). */
export interface CycleDayLogInput {
  date: string;
  flow?: FlowLevel;
  basalBodyTempC?: number;
  ovulationTest?: OvulationTest;
  cervicalMucus?: CervicalMucus;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  symptoms?: { key: string }[];
  note?: string;
  loggedAt: string;
  source?: "MANUAL";
}
