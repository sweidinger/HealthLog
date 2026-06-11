"use client";

/**
 * v1.4.47 W3 — "Hide Coach" toggle card.
 *
 * Persists via `PATCH /api/auth/me/disable-coach`; the response
 * invalidates `queryKeys.authMe()` so every Coach mount point on the
 * client (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the inline
 * `<CoachLaunchButton>` pill, the `/targets` page CTAs) re-renders
 * with the new `user.disableCoach` value on the next React Query
 * refetch tick — no full reload required.
 *
 * The optimistic-update pattern mirrors `<MoodReminderCard>`: the
 * Switch flips immediately, the mutation rolls back on error.
 *
 * v1.16.4 — header follows the shared `SettingsCardHeader` contract
 * (icon column + title + switch in the status slot) so the card reads
 * like its siblings instead of carrying its own bespoke header row.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircleOff } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiPatch } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export function DisableCoachCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Optimistic-update flag — null means "no in-flight change",
  // otherwise it overrides the wire value until the mutation
  // settles. Mirrors the `<MoodReminderCard>` pattern so the Switch
  // reacts instantly to the user's tap.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // v1.4.48 M2 — auto-clear the inline `<p role="status">` line 3 s
  // after the mutation settles so a Settings card the user scrolled
  // past minutes earlier doesn't keep echoing a stale "Coach hidden"
  // banner. The ref tracks the in-flight timer so we can clear it on
  // unmount + on a follow-up toggle (otherwise a rapid double-tap
  // could leave a stray timer pointing at a stale message).
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

  const checked = optimistic ?? user?.disableCoach ?? false;

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      await apiPatch("/api/auth/me/disable-coach", { disableCoach: next });
      return next;
    },
    onSuccess: (next) => {
      setMsg(
        next
          ? t("settings.ai.disableCoach.savedHidden")
          : t("settings.ai.disableCoach.savedShown"),
      );
      setMsgType("success");
      // Surface the new value to every Coach gate via the shared
      // `useAuth()` query — the gates re-render once React Query
      // re-fetches /api/auth/me with the updated `disableCoach` field.
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error
          ? err.message
          : t("settings.ai.disableCoach.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleToggle(next: boolean) {
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
    <section
      aria-labelledby="settings-ai-disable-coach-title"
      data-testid="settings-disable-coach-card"
      className="bg-card border-border rounded-xl border p-6"
    >
      <SettingsCardHeader
        icon={MessageCircleOff}
        title={t("settings.ai.disableCoach.title")}
        titleId="settings-ai-disable-coach-title"
        description={t("settings.ai.disableCoach.description")}
        status={
          <Switch
            data-testid="settings-disable-coach-switch"
            checked={checked}
            onCheckedChange={handleToggle}
            disabled={!isAuthenticated || mutation.isPending}
            aria-label={t("settings.ai.disableCoach.toggleAria")}
          />
        }
      />
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive mt-3 pl-7 text-xs"
              : "text-muted-foreground mt-3 pl-7 text-xs"
          }
        >
          {msg}
        </p>
      )}
    </section>
  );
}
