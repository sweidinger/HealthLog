"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.17.0 — sleep-debt DTO (mirrors the server `SleepDebtDto`). `partial` is
 * the calm "still learning" state below the night threshold; `ready` asserts
 * the cumulative deficit.
 */
export interface SleepDebtDto {
  state: "partial" | "ready";
  debtMinutes: number;
  needMinutes: number;
  nightsCounted: number;
  windowNights: number;
  nightsUntilReady: number;
}

/** v1.17.0 — chronotype DTO (mirrors the server `ChronotypeDto`). */
export interface ChronotypeDto {
  state: "learning" | "ready";
  msfMinutes: number | null;
  msfScMinutes: number | null;
  band:
    | "extreme_early"
    | "early"
    | "intermediate"
    | "late"
    | "extreme_late"
    | null;
  socialJetlagMinutes: number | null;
  freeNightsCounted: number;
  workNightsCounted: number;
  freeNightsUntilReady: number;
}

export interface SleepRhythmDto {
  sleepDebt: SleepDebtDto;
  chronotype: ChronotypeDto;
}

/**
 * Read the server-authoritative sleep-rhythm DTO. Gated on `enabled` so a
 * source-less account never fetches; shares the measurement-write
 * invalidation prefix (`["sleep-rhythm"]`).
 */
export function useSleepRhythm(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sleepRhythm(),
    queryFn: () => apiGet<SleepRhythmDto>("/api/sleep/rhythm"),
    enabled,
    staleTime: 60 * 1000,
  });
}
