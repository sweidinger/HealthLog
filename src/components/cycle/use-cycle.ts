"use client";

/**
 * v1.15.0 — cycle read + write hooks.
 *
 * Reads unwrap `(await res.json()).data` per the project envelope rule;
 * every key is factory-routed through `queryKeys.cycle*`. Writes invalidate
 * the whole `["cycle"]` prefix via `cycleDependentKeys` so the calendar,
 * wheel, predictions panel, and history repaint in lockstep after a quick
 * log.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cycleDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type {
  CalendarResponse,
  CycleDayLogDTO,
  CycleDayLogInput,
  CycleHistoryResponse,
  CycleProfileDTO,
} from "./types";
import type { CyclePhaseCrosstabRow } from "./cycle-phase-crosstab";

/** The `/api/cycle/insights` read: the phase-contrast rows + the headline. */
export interface CycleInsightsResponse {
  rows: CyclePhaseCrosstabRow[];
  headline: CyclePhaseCrosstabRow | null;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const json = await res.json();
  return json.data as T;
}

/**
 * The local-timezone `YYYY-MM-DD` for a Date (default: now). Cycle day-keys
 * are tz-anchored on the server; the client must derive the key from the
 * user's wall-clock day, never from `toISOString()` (which is UTC and rolls
 * the date over near midnight).
 */
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Read the full day-log for one date so the log-day sheet pre-fills (no
 * blank-sheet data loss) and Delete can resolve the row id. `null` when
 * nothing is logged that day. Enabled only when a date is supplied.
 */
export function useCycleDayLog(date: string | null) {
  return useQuery({
    queryKey: queryKeys.cycleDayLog(date ?? ""),
    enabled: date !== null,
    queryFn: () =>
      fetch(`/api/cycle/day-logs?date=${date}`).then((r) =>
        unwrap<CycleDayLogDTO | null>(r),
      ),
    staleTime: 30_000,
  });
}

export function useCycleCalendar(from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.cycleCalendar(from, to),
    queryFn: () =>
      fetch(`/api/cycle/calendar?from=${from}&to=${to}`).then((r) =>
        unwrap<CalendarResponse>(r),
      ),
    staleTime: 60_000,
  });
}

export function useCycleHistory(limit = 24) {
  return useQuery({
    queryKey: queryKeys.cycleHistory(limit),
    queryFn: () =>
      fetch(`/api/cycle/cycles?limit=${limit}`).then((r) =>
        unwrap<CycleHistoryResponse>(r),
      ),
    staleTime: 60_000,
  });
}

export function useCycleProfile() {
  return useQuery({
    queryKey: queryKeys.cycleProfile(),
    queryFn: () =>
      fetch("/api/cycle/profile").then((r) => unwrap<CycleProfileDTO>(r)),
    staleTime: 5 * 60_000,
  });
}

/**
 * The FDR-guarded phase-correlation surface: the luteal-vs-follicular contrast
 * rows + the one headline finding. Gated server-side; reads only on the cycle
 * insights tab.
 */
export function useCycleInsights() {
  return useQuery({
    queryKey: queryKeys.cycleInsights(),
    queryFn: () =>
      fetch("/api/cycle/insights").then((r) =>
        unwrap<CycleInsightsResponse>(r),
      ),
    staleTime: 5 * 60_000,
  });
}

/** A fresh idempotency key per write attempt (matches the iOS Outbox shape). */
function idempotencyKey(): string {
  return crypto.randomUUID();
}

export function useLogDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CycleDayLogInput) => {
      const res = await fetch("/api/cycle/day-logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey(),
        },
        body: JSON.stringify(input),
      });
      return unwrap<unknown>(res);
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
  });
}

export function useStartPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (date: string) => {
      const res = await fetch("/api/cycle/period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          date,
          loggedAt: new Date().toISOString(),
        }),
      });
      return unwrap<unknown>(res);
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
  });
}

/** The one-tap "end period" boundary (`action:"end"`). */
export function useEndPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (date: string) => {
      const res = await fetch("/api/cycle/period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "end",
          date,
          loggedAt: new Date().toISOString(),
        }),
      });
      return unwrap<unknown>(res);
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
  });
}

/** Soft-delete a logged day by its row id (the GET supplies the id). */
export function useDeleteDayLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/cycle/day-logs/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Request failed: ${res.status}`);
      }
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
  });
}

export interface CyclePrefsPatch {
  enabled?: boolean;
  goal?: CycleProfileDTO["goal"];
  rawChartMode?: boolean;
  predictionEnabled?: boolean;
  discreetNotifications?: boolean;
  sensitiveCategoryEncryption?: boolean;
  typicalCycleLength?: number | null;
  typicalPeriodLength?: number | null;
  lutealPhaseLength?: number | null;
}

export function useUpdateCyclePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: CyclePrefsPatch) => {
      const res = await fetch("/api/auth/me/cycle-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return unwrap<CycleProfileDTO>(res);
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      // The enable flag + goal live on /api/auth/me too — repaint the nav gate.
      void qc.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });
}
