"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import type { TimeFormatPreference } from "@/lib/format-locale";
import { storeTimeFormat } from "@/lib/time-format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Hour-cycle (12h/24h) preference as a Profile dropdown.
 *
 * Lives beside the language select because it is the same kind of personal
 * display preference; the en locale otherwise pins users to the AM/PM
 * convention with no way out (and vice versa). AUTO follows the locale
 * convention, H24 forces a 24-hour clock, H12 forces AM/PM.
 *
 * Persistence mirrors `<UnitPreferenceSelect>`: a change PATCHes the profile
 * endpoint immediately and invalidates `queryKeys.authMe()`. The localStorage
 * mirror is written synchronously so every `useFormatters()` consumer and the
 * legacy `src/lib/format.ts` helpers repaint without waiting for the refetch.
 */
export function TimeFormatSelect({
  isAuthenticated,
  id = "time-format",
}: {
  isAuthenticated: boolean;
  id?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<TimeFormatPreference | null>(
    null,
  );
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

  const value: TimeFormatPreference = optimistic ?? user?.timeFormat ?? "AUTO";

  const mutation = useMutation({
    mutationFn: async (next: TimeFormatPreference) => {
      const res = await apiFetchRaw("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeFormat: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: (next) => {
      // Repaint every formatter consumer right away; the /me refetch below
      // re-asserts the same value once it settles.
      storeTimeFormat(next);
      setMsg(t("settings.timeFormat.saved"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error ? err.message : t("settings.timeFormat.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleSelect(next: TimeFormatPreference) {
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
      <Label htmlFor={id}>{t("settings.timeFormat.title")}</Label>
      <NativeSelect
        id={id}
        data-testid="settings-time-format-select"
        value={value}
        disabled={!isAuthenticated || mutation.isPending}
        onChange={(e) => handleSelect(e.target.value as TimeFormatPreference)}
      >
        <option value="AUTO">{t("settings.timeFormat.auto")}</option>
        <option value="H24">{t("settings.timeFormat.h24")}</option>
        <option value="H12">{t("settings.timeFormat.h12")}</option>
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
        {msg ?? t("settings.timeFormat.description")}
      </p>
    </div>
  );
}
