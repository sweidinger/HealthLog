"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

// v1.17.0 — the wire shape IS the server DTO. Import the type directly (erased
// at build, so no server code reaches the client bundle) rather than keeping a
// second hand-mirrored copy that silently drifts when the server shape changes.
import type {
  SleepDebtDto,
  ChronotypeDto,
  SleepRhythmDto,
} from "@/lib/insights/derived/sleep-rhythm";

export type { SleepDebtDto, ChronotypeDto, SleepRhythmDto };

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
