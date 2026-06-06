/**
 * Cycle row → wire-DTO mappers (ios-contract §2 + §3).
 *
 * The canonical `CycleDayLogDTO` and `MenstrualCycleDTO` shapes the iOS
 * client mirrors. `notesEncrypted` is decrypted fail-soft on read (a
 * key-rotation gap on one row reads `null`, never 500s the whole page).
 * Symptom links are flattened to `[{ key, severity }]` using the catalog
 * key (severity is not yet persisted per-link in v1.15.0 — the join is a
 * presence link; severity rides the input but the catalog link carries
 * presence only, so it reads back `null`).
 */
import { decrypt } from "@/lib/crypto";
import type { CyclePredictionResult } from "@/lib/cycle/types";
import type {
  CycleDayLog,
  CycleSymptomLink,
  CycleSymptom,
  MenstrualCycle,
} from "@/generated/prisma/client";

export interface CycleSymptomDTO {
  key: string;
  severity: number | null;
}

export interface CycleDayLogDTO {
  id: string;
  date: string;
  cycleId: string | null;
  flow: string | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  ovulationTest: string | null;
  cervicalMucus: string | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
  symptoms: CycleSymptomDTO[];
  note: string | null;
  source: string;
  externalId: string | null;
  syncVersion: number;
  updatedAt: string;
  deletedAt: string | null;
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

type DayLogWithLinks = CycleDayLog & {
  symptomLinks?: (CycleSymptomLink & { symptom: Pick<CycleSymptom, "key"> })[];
};

/** Decrypt a day-log note fail-soft (null on missing / undecryptable). */
function decryptNote(notesEncrypted: string | null): string | null {
  if (!notesEncrypted) return null;
  try {
    return decrypt(notesEncrypted);
  } catch {
    return null;
  }
}

interface SensitiveEnvelope {
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: string | null;
  progesteroneTest?: string | null;
  contraceptive?: string | null;
}

/**
 * Decrypt the sensitive-category envelope fail-soft. When
 * `sensitiveCategoryEncryption` was ON at write the five intent fields live
 * here instead of the plaintext columns; an undecryptable envelope reads as
 * an empty object so the page never 500s.
 */
function decryptSensitive(envelope: string | null): SensitiveEnvelope {
  if (!envelope) return {};
  try {
    return JSON.parse(decrypt(envelope)) as SensitiveEnvelope;
  } catch {
    return {};
  }
}

export function toCycleDayLogDTO(row: DayLogWithLinks): CycleDayLogDTO {
  // Prefer the encryption envelope when present; else read the plaintext
  // columns (the flag-OFF path).
  const enc = decryptSensitive(row.sensitiveEncrypted);
  const hasEnvelope = row.sensitiveEncrypted != null;
  return {
    id: row.id,
    date: row.date,
    cycleId: row.cycleId,
    flow: row.flow,
    intermenstrualBleeding: row.intermenstrualBleeding,
    basalBodyTempC: row.basalBodyTempC,
    ovulationTest: row.ovulationTest,
    cervicalMucus: row.cervicalMucus,
    sexualActivity: hasEnvelope ? (enc.sexualActivity ?? false) : row.sexualActivity,
    protectedSex: hasEnvelope ? (enc.protectedSex ?? null) : row.protectedSex,
    pregnancyTest: hasEnvelope ? (enc.pregnancyTest ?? null) : row.pregnancyTest,
    progesteroneTest: hasEnvelope
      ? (enc.progesteroneTest ?? null)
      : row.progesteroneTest,
    contraceptive: hasEnvelope ? (enc.contraceptive ?? null) : row.contraceptive,
    symptoms: (row.symptomLinks ?? []).map((l) => ({
      key: l.symptom.key,
      severity: null,
    })),
    note: decryptNote(row.notesEncrypted),
    source: row.source,
    externalId: row.externalId,
    syncVersion: row.syncVersion,
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toMenstrualCycleDTO(row: MenstrualCycle): MenstrualCycleDTO {
  return {
    id: row.id,
    startDate: row.startDate,
    endDate: row.endDate,
    periodEndDate: row.periodEndDate,
    lengthDays: row.lengthDays,
    ovulationDate: row.ovulationDate,
    ovulationConfirmed: row.ovulationConfirmed,
    isPredicted: row.isPredicted,
    syncVersion: row.syncVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The Prisma `include` that hydrates symptom links → DTO keys. */
export const dayLogSymptomInclude = {
  symptomLinks: { include: { symptom: { select: { key: true } } } },
} as const;

export interface CyclePredictionDTO {
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

/**
 * Map the engine result to the wire `CyclePredictionDTO`. Fertile-window
 * fields (and the predicted ovulation) are suppressed unless the goal
 * permits them (ios-contract §2.D — GENERAL_HEALTH / PERIMENOPAUSE / OFF
 * never surface a fertile window; the suppression is server-side, never
 * iOS).
 */
export function toCyclePredictionDTO(
  result: CyclePredictionResult,
  goalAllowsFertile: boolean,
  disclaimer: string,
): CyclePredictionDTO {
  return {
    method: result.method,
    nextPeriodStart: result.nextPeriodStart,
    nextPeriodStartLow: result.nextPeriodStartLow,
    nextPeriodStartHigh: result.nextPeriodStartHigh,
    fertileWindowStart: goalAllowsFertile ? result.fertileWindowStart : null,
    fertileWindowEnd: goalAllowsFertile ? result.fertileWindowEnd : null,
    predictedOvulation: goalAllowsFertile ? result.predictedOvulation : null,
    confidence: result.confidence,
    cyclesObserved: result.cyclesObserved,
    stillLearning: result.stillLearning,
    disclaimer,
  };
}

/** The full profile read DTO (ios-contract §2.G). */
export interface CycleProfileDTO {
  goal: string;
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

export function toCycleProfileDTO(
  row: MenstrualCycleProfileRow,
  cycleTrackingEnabled: boolean,
): CycleProfileDTO {
  return {
    goal: row.goal,
    cycleTrackingEnabled,
    rawChartMode: row.rawChartMode,
    predictionEnabled: row.predictionEnabled,
    discreetNotifications: row.discreetNotifications,
    sensitiveCategoryEncryption: row.sensitiveCategoryEncryption,
    typicalCycleLength: row.typicalCycleLength,
    typicalPeriodLength: row.typicalPeriodLength,
    lutealPhaseLength: row.lutealPhaseLength,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type MenstrualCycleProfileRow = {
  goal: string;
  rawChartMode: boolean;
  predictionEnabled: boolean;
  discreetNotifications: boolean;
  sensitiveCategoryEncryption: boolean;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  updatedAt: Date;
};

/**
 * Whether a goal surfaces the fertile window. Per the v1.15 contract the
 * window is gated to the conception goal only — GENERAL_HEALTH /
 * AVOID_PREGNANCY / PERIMENOPAUSE / OFF suppress it (the suppression is
 * always server-side, never iOS).
 */
export function goalAllowsFertileWindow(goal: string): boolean {
  return goal === "TRYING_TO_CONCEIVE";
}
