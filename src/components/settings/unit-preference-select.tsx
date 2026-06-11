"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";

type UnitPreference = "metric" | "imperial";

/**
 * v1.12.x — unit system (metric/imperial) as a Profile dropdown.
 *
 * The metric/imperial preference is a personal setting like language
 * and timezone, so it lives in the Profile form beside the timezone
 * picker rather than in a standalone card (it replaces the retired
 * `<UnitPreferenceCard>`). Persistence is unchanged: a change PATCHes
 * `/api/auth/me/unit-preference` immediately and invalidates
 * `queryKeys.authMe()` + `queryKeys.userUnitPreference()` so every chart
 * display transform (km/h vs mph, km vs mi) re-renders on the next /me
 * refetch — no manual reload, no contract change.
 */
export function UnitPreferenceSelect({
  isAuthenticated,
  id = "unit-preference",
}: {
  isAuthenticated: boolean;
  id?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<UnitPreference | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  function scheduleClear() {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setMsg(null);
      setMsgType(null);
    }, 3000);
  }

  const value: UnitPreference = optimistic ?? user?.unitPreference ?? "metric";

  const mutation = useMutation({
    mutationFn: async (next: UnitPreference) => {
      const res = await apiFetchRaw("/api/auth/me/unit-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitPreference: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: () => {
      setMsg(t("settings.dashboard.units.saved"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.userUnitPreference(),
      });
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error
          ? err.message
          : t("settings.dashboard.units.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleSelect(next: UnitPreference) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    mutation.mutate(next);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("settings.dashboard.units.title")}</Label>
      <NativeSelect
        id={id}
        data-testid="settings-unit-preference-select"
        value={value}
        disabled={!isAuthenticated || mutation.isPending}
        onChange={(e) => handleSelect(e.target.value as UnitPreference)}
      >
        <option value="metric">{t("settings.dashboard.units.metric")}</option>
        <option value="imperial">
          {t("settings.dashboard.units.imperial")}
        </option>
      </NativeSelect>
      <p
        role="status"
        aria-live="polite"
        className={
          msgType === "error"
            ? "text-destructive text-xs"
            : "text-muted-foreground text-xs"
        }
      >
        {msg ?? t("settings.dashboard.units.description")}
      </p>
    </div>
  );
}
