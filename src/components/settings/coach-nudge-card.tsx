"use client";

/**
 * v1.15.20 — Settings → Notifications opt-out for the proactive Coach
 * nudge (the daily 05:15 cron that points the user at /insights/coach
 * when a deterministic trigger fires). Default ON; the toggle writes
 * `notificationPrefs.coach.nudgesEnabled` through the roaming
 * notification-prefs blob so web + iOS share one source of truth.
 *
 * Mirrors `<MoodReminderCard>` (optimistic switch, auto-clearing inline
 * status line).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleHeart } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface NotificationPrefsShape {
  coach: { nudgesEnabled: boolean };
}

export function CoachNudgeCard({
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
      const res = await fetch("/api/auth/me/notification-prefs");
      if (!res.ok) throw new Error("Failed to load notification prefs");
      return (await res.json()).data as NotificationPrefsShape;
    },
    enabled: isAuthenticated,
  });

  const enabled = optimistic ?? prefs?.coach?.nudgesEnabled ?? true;

  async function handleToggle(next: boolean) {
    setOptimistic(next);
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    const res = await fetch("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coach: { nudgesEnabled: next } }),
    });

    if (res.ok) {
      setMsg(
        next
          ? t("notifications.coachNudge.enabledToast")
          : t("notifications.coachNudge.disabledToast"),
      );
      setMsgType("success");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setOptimistic(null);
      scheduleClear();
    } else {
      setOptimistic(null);
      setMsg(t("notifications.coachNudge.saveError"));
      setMsgType("error");
      scheduleClear();
    }
    setSaving(false);
  }

  return (
    <section
      aria-labelledby="settings-coach-nudge-title"
      className="bg-card rounded-lg border p-4 sm:p-6"
      data-testid="settings-coach-nudge-card"
    >
      <SettingsCardHeader
        icon={MessageCircleHeart}
        title={t("notifications.coachNudge.title")}
        titleId="settings-coach-nudge-title"
        description={t("notifications.coachNudge.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.coachNudge.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.coachNudge.statusOn")
                : t("notifications.coachNudge.statusOff")}
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
    </section>
  );
}
