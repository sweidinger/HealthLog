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
  CervicalMucus,
  ContraceptiveKind,
  CycleDayLogDTO,
  CycleDayLogInput,
  CycleHistoryResponse,
  CycleProfileDTO,
  CycleSymptomSelection,
  FlowLevel,
  HomeTestResult,
  OvulationTest,
} from "./types";
import type { CyclePhaseCrosstabRow } from "./cycle-phase-crosstab";

/** One symptom's per-phase clustering (mirrors `SymptomPhasePatternRow`). */
export interface SymptomPhaseRow {
  symptomKey: string;
  counts: {
    MENSTRUAL: number;
    FOLLICULAR: number;
    OVULATORY: number;
    LUTEAL: number;
  };
  total: number;
  topPhase: "MENSTRUAL" | "FOLLICULAR" | "OVULATORY" | "LUTEAL";
  topShare: number;
}

/** The `/api/cycle/insights` read: the phase-contrast rows + the headline. */
export interface CycleInsightsResponse {
  rows: CyclePhaseCrosstabRow[];
  headline: CyclePhaseCrosstabRow | null;
  symptomPatterns: SymptomPhaseRow[];
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

/** One per-user custom symptom: a `custom:<uuid>` key + decrypted label. */
export interface CustomSymptomDTO {
  key: string;
  label: string | null;
  icon: string | null;
  custom: true;
}

/**
 * The caller's own custom symptoms, labels decrypted server-side. The log-day
 * sheet merges these into the seeded chip grid under the `custom` category.
 */
export function useCustomSymptoms() {
  return useQuery({
    queryKey: queryKeys.cycleCustomSymptoms(),
    queryFn: () =>
      fetch("/api/cycle/symptoms/custom").then((r) =>
        unwrap<{ symptoms: CustomSymptomDTO[] }>(r),
      ),
    staleTime: 5 * 60_000,
  });
}

/** The `errorCode` the create POST returns when the per-user cap is hit. */
export const CUSTOM_SYMPTOM_LIMIT_ERROR_CODE = "cycle.symptom.custom.limit";

/** An error that preserves the envelope `errorCode` so callers can branch. */
export class CustomSymptomError extends Error {
  constructor(
    public readonly errorCode: string | null,
    public readonly status: number,
  ) {
    super(errorCode ?? `Request failed: ${status}`);
    this.name = "CustomSymptomError";
  }
}

/** Create a custom symptom (mint `custom:<uuid>`, encrypt the label). */
export function useCreateCustomSymptom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { label: string; icon?: string | null }) => {
      const res = await fetch("/api/cycle/symptoms/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        // Preserve the envelope errorCode so the UI can tell the cap hit
        // (cycle.symptom.custom.limit) apart from a transient/validation error.
        const errorCode = await res
          .json()
          .then((j) => (j?.meta?.errorCode as string | undefined) ?? null)
          .catch(() => null);
        throw new CustomSymptomError(errorCode, res.status);
      }
      const json = await res.json();
      return json.data as CustomSymptomDTO;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.cycleCustomSymptoms() }),
  });
}

/** Soft-hide a custom symptom by its key (history-preserving). */
export function useDeleteCustomSymptom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(
        `/api/cycle/symptoms/custom/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
      return unwrap<{ key: string; purged: boolean }>(res);
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
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

/**
 * The PATCH body for editing an existing day-log. Every field nullable so the
 * web sheet can CLEAR a previously-set value (the POST merge can only add or
 * keep — it never nulls an omitted field, so an edit that deselects a chip must
 * route through PATCH with an explicit null).
 */
export interface CycleDayLogPatch {
  flow?: FlowLevel | null;
  intermenstrualBleeding?: boolean;
  basalBodyTempC?: number | null;
  ovulationTest?: OvulationTest | null;
  cervicalMucus?: CervicalMucus | null;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: HomeTestResult | null;
  progesteroneTest?: HomeTestResult | null;
  contraceptive?: ContraceptiveKind | null;
  symptoms?: CycleSymptomSelection[];
  note?: string | null;
}

/** Edit an existing day-log by id (PATCH — accepts explicit null to clear). */
export function usePatchDayLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: CycleDayLogPatch;
    }) => {
      const res = await fetch(`/api/cycle/day-logs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return unwrap<CycleDayLogDTO>(res);
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

/**
 * Hard-delete EVERY cycle row the user owns (day-logs, cycles, predictions,
 * the cycle audit trail, and the cycle reminder-delivery ledger rows). The
 * privacy "purge" the post-Dobbs threat model promises — distinct from the
 * per-row soft-delete. Invalidates the whole cycle prefix + the nav gate.
 */
export function useDeleteAllCycleData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cycle/all", { method: "DELETE" });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return unwrap<{ purged: boolean }>(res);
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      void qc.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
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
