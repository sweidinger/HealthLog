"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";

/**
 * v1.16.11 — medication low-stock alert threshold (Settings →
 * Notifications). The threshold is REMAINING RUNWAY: notify when a
 * tracked medication's supply covers fewer than N days (1–60, default
 * 7); the switch off persists `null` (alert off). Reads the same
 * per-user prefs blob the mood / coach cards use and writes through
 * `PATCH /api/auth/me/notification-prefs`; the value also surfaces on
 * `GET /api/settings/reminder-thresholds` for API consumers, so the
 * save invalidates both keys.
 */

interface NotificationPrefsShape {
  medication: { lowStockRunwayDays: number | null };
}

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 60;

export function LowStockCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<number | null | undefined>(
    undefined,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // Auto-clear the inline status line 3 s after the mutation settles —
  // the MoodReminderCard pattern, including the unmount / re-toggle
  // timer hygiene.
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

  const persisted =
    prefs?.medication?.lowStockRunwayDays === undefined
      ? DEFAULT_DAYS
      : prefs.medication.lowStockRunwayDays;
  const current = optimistic === undefined ? persisted : optimistic;
  const enabled = current !== null;
  const days = current ?? DEFAULT_DAYS;

  async function persist(next: number | null, successMsg: string) {
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
      body: JSON.stringify({ medication: { lowStockRunwayDays: next } }),
    });

    if (res.ok) {
      setMsg(successMsg);
      setMsgType("success");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.authNotificationPrefs(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.settingsReminderThresholds(),
        }),
      ]);
      setOptimistic(undefined);
    } else {
      setOptimistic(undefined);
      setMsg(t("notifications.lowStock.saveError"));
      setMsgType("error");
    }
    scheduleClear();
    setSaving(false);
  }

  async function handleToggle(next: boolean) {
    await persist(
      next ? days : null,
      next
        ? t("notifications.lowStock.enabledToast")
        : t("notifications.lowStock.disabledToast"),
    );
  }

  function commitDraft() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed));
    if (clamped === days) return;
    void persist(clamped, t("notifications.lowStock.savedToast"));
  }

  return (
    <section
      // `id` is the anchor target of the supply tab's cross-link
      // (`/settings/notifications#low-stock`) — keep it stable.
      id="low-stock"
      aria-labelledby="settings-low-stock-title"
      className="bg-card border-border scroll-mt-20 rounded-xl border p-4 sm:p-6"
    >
      <SettingsCardHeader
        icon={PackageOpen}
        title={t("notifications.lowStock.title")}
        titleId="settings-low-stock-title"
        description={t("notifications.lowStock.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.lowStock.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.lowStock.statusOn")
                : t("notifications.lowStock.statusOff")}
            </span>
          </label>
        }
      />
      {enabled && (
        <div className="mt-4 flex min-h-11 items-center gap-3 pl-7">
          <label htmlFor="low-stock-days" className="text-sm font-medium">
            {t("notifications.lowStock.daysLabel")}
          </label>
          <Input
            id="low-stock-days"
            type="number"
            inputMode="numeric"
            min={MIN_DAYS}
            max={MAX_DAYS}
            className="w-24"
            value={draft ?? String(days)}
            disabled={!isAuthenticated || saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
            aria-label={t("notifications.lowStock.daysAria")}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
        </div>
      )}
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
      {/* v1.16.11 — back-link to the medications list, the surface the
          alert is about (the supply tab links here the same way). */}
      <p className="mt-3 pl-7">
        <Link
          href="/medications"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
          data-slot="low-stock-medications-link"
        >
          {t("notifications.lowStock.medicationsLink")}
        </Link>
      </p>
    </section>
  );
}
