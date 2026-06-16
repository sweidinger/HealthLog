"use client";

/**
 * v1.17.1 — data hook for Vorsorge (measurement) reminders.
 *
 * Wraps the `/api/measurement-reminders` CRUD + satisfy surface behind
 * TanStack Query. Every mutation invalidates the one
 * `measurementReminders()` root so the section list and the dashboard
 * tile repaint in lockstep. The DTO is the server-authoritative shape —
 * the client renders `nextDueAt` as-is, never recomputing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export interface MeasurementReminder {
  id: string;
  label: string;
  measurementType: string | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  /**
   * v1.18.1 — optional course-window end (ISO-8601). NULL ⇒ open-ended; a
   * Coach-suggested time-boxed protocol carries a non-NULL value and the
   * UI renders an "until <date>" line.
   */
  endsOn: string | null;
  /**
   * v1.18.1 — provenance: `VORSORGE` (user-created) or `COACH` (minted from
   * a Coach cadence suggestion). The UI labels the source and translates a
   * COACH row's `label` (which carries an i18n key, not free text).
   */
  origin: "VORSORGE" | "COACH";
  notifyHour: number;
  location: string | null;
  nextDueAt: string | null;
  lastSatisfiedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMeasurementReminderBody {
  label: string;
  measurementType?: string | null;
  intervalDays?: number | null;
  rrule?: string | null;
  anchorDate?: string | null;
  notifyHour?: number;
  location?: string | null;
  enabled?: boolean;
}

export type UpdateMeasurementReminderBody = Partial<
  CreateMeasurementReminderBody
>;

const BASE = "/api/measurement-reminders";

export function useMeasurementReminders(enabled = true) {
  return useQuery({
    queryKey: queryKeys.measurementReminders(),
    queryFn: () => apiGet<MeasurementReminder[]>(BASE),
    enabled,
  });
}

export function useMeasurementReminderMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: queryKeys.measurementReminders() });

  const create = useMutation({
    mutationKey: queryKeys.measurementReminderCreate(),
    mutationFn: (body: CreateMeasurementReminderBody) =>
      apiPost<MeasurementReminder>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.measurementReminderUpdate(),
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: UpdateMeasurementReminderBody;
    }) => apiPatch<MeasurementReminder>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.measurementReminderDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  const satisfy = useMutation({
    mutationKey: queryKeys.measurementReminderSatisfy(),
    mutationFn: (id: string) =>
      apiPost<MeasurementReminder>(`${BASE}/${id}/satisfy`),
    onSuccess: invalidate,
  });

  return { create, update, remove, satisfy };
}
