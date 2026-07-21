"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";

/**
 * Fork ADHS Stage B.2 — the medication effect-window check-in reminder toggle.
 *
 * A single opt-in switch: when on, the server nudges the user to open the daily
 * guided check-in inside the drug's effect windows (a while after intake + the
 * afternoon rebound). The timing itself comes from each medication's drug
 * profile, so there is no hour picker — just the master switch. Mirrors the
 * `<MoodReminderCard>` optimistic-update + auto-clearing status pattern.
 *
 * The opt-in lives in `notificationPrefs.medicationCheckin.enabled` (default
 * OFF); the cron fires only for profiled medications with an intake time.
 */
interface NotificationPrefsShape {
  medicationCheckin: { enabled: boolean };
}

export function MedicationCheckinReminderCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
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

  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () => {
      return apiGet<NotificationPrefsShape>("/api/auth/me/notification-prefs");
    },
    enabled: isAuthenticated,
  });

  const enabled = optimistic ?? prefs?.medicationCheckin?.enabled ?? false;

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ medicationCheckin: { enabled: next } }),
    });

    if (res.ok) {
      setMsg(
        next
          ? t("notifications.medicationCheckinReminder.enabledToast")
          : t("notifications.medicationCheckinReminder.disabledToast"),
      );
      setMsgType("success");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimistic(null);
      scheduleClear();
    } else {
      setOptimistic(null);
      setMsg(t("notifications.medicationCheckinReminder.saveError"));
      setMsgType("error");
      scheduleClear();
    }
    setSaving(false);
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-medication-checkin-reminder-title"
    >
      <SettingsCardHeader
        icon={ClipboardCheck}
        title={t("notifications.medicationCheckinReminder.title")}
        titleId="settings-medication-checkin-reminder-title"
        description={t("notifications.medicationCheckinReminder.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t(
                "notifications.medicationCheckinReminder.toggleAria",
              )}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.medicationCheckinReminder.statusOn")
                : t("notifications.medicationCheckinReminder.statusOff")}
            </span>
          </label>
        }
      />
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive mt-3 pl-7 text-sm"
              : "text-muted-foreground mt-3 pl-7 text-sm"
          }
        >
          {msg}
        </p>
      )}
    </SettingsCard>
  );
}
