/**
 * v1.15.0 — client-side mirrors of the `/api/cycle/*` response DTOs
 * (ios-contract §2). These match `src/lib/cycle/dto.ts` +
 * `src/lib/cycle/engine-adapter.ts` field-for-field so the read hooks can
 * type the unwrapped `(await res.json()).data`.
 */

export type CyclePhase = "MENSTRUAL" | "FOLLICULAR" | "OVULATORY" | "LUTEAL";

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
  /** Logged basal body temperature (°C), or null. Feeds the BBT chart. */
  basalBodyTempC: number | null;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
}

export interface CyclePrediction {
  method: string;
  nextPeriodStart: string;
  nextPeriodStartLow: string;
  nextPeriodStartHigh: string;
  fertileWindowStart: string | null;
  fertileWindowEnd: string | null;
  predictedOvulation: string | null;
  ovulationConfirmed: boolean;
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
  /**
   * Cold-start gate (mirrors `prediction.stillLearning`): true while < 3 cycles
   * are observed. When set, `days` carries no fertile window, ovulation dot, or
   * phase band — render the calm "learning your cycle" state over the grid.
   */
  stillLearning: boolean;
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
export type HomeTestResult = "NEGATIVE" | "POSITIVE" | "INDETERMINATE";

export type ContraceptiveKind =
  | "NONE"
  | "UNSPECIFIED"
  | "IMPLANT"
  | "INJECTION"
  | "IUD"
  | "INTRAVAGINAL_RING"
  | "ORAL"
  | "PATCH"
  | "EMERGENCY";

export interface CycleSymptomSelection {
  key: string;
  severity?: number | null;
}

export interface CycleDayLogInput {
  date: string;
  flow?: FlowLevel;
  intermenstrualBleeding?: boolean;
  basalBodyTempC?: number;
  ovulationTest?: OvulationTest;
  cervicalMucus?: CervicalMucus;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: HomeTestResult;
  progesteroneTest?: HomeTestResult;
  contraceptive?: ContraceptiveKind;
  symptoms?: CycleSymptomSelection[];
  note?: string;
  loggedAt: string;
  source?: "MANUAL";
}

/** The full day-log row read back from `GET /api/cycle/day-logs?date=`. */
export interface CycleDayLogDTO {
  id: string;
  date: string;
  cycleId: string | null;
  flow: FlowLevel | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
  symptoms: { key: string; severity: number | null }[];
  note: string | null;
  source: string;
  externalId: string | null;
  syncVersion: number;
  updatedAt: string;
  deletedAt: string | null;
}
