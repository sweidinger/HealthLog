"use client";

/**
 * v1.15.20 — Settings → AI "About me" panel.
 *
 * Free-text self-description the user writes for the AI surfaces. The
 * server stores it encrypted (`UserHealthProfile.aboutMeEncrypted`) and
 * injects it into the Coach system prompt + the daily briefing as a
 * delimited, user-provided context block.
 *
 *   GET /api/coach/about-me — { aboutMe, updatedAt, maxChars }
 *   PUT /api/coach/about-me — { aboutMe } (empty string clears)
 *
 * Plain text only — the value is rendered exclusively through a
 * `<textarea>` and React text children; no markdown anywhere.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, NotebookPen, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

const FALLBACK_MAX_CHARS = 4000;

interface AboutMeData {
  aboutMe: string | null;
  updatedAt: string | null;
  maxChars: number;
}

async function fetchAboutMe(): Promise<AboutMeData> {
  const res = await fetch("/api/coach/about-me");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()).data as AboutMeData;
}

export function AboutMeSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: fetchAboutMe,
    enabled: isAuthenticated,
  });

  const saved = query.data?.aboutMe ?? "";
  const maxChars = query.data?.maxChars ?? FALLBACK_MAX_CHARS;
  const value = draft ?? saved;
  // A draft equal to the server value renders identically and keeps the
  // save button disabled, so no effect is needed to clear it — the
  // save mutation's onSuccess resets the draft after a round-trip.
  const dirty = draft !== null && draft !== saved;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    mutationFn: async (aboutMe: string) => {
      const res = await fetch("/api/coach/about-me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aboutMe }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return ((await res.json()).data as AboutMeData).aboutMe ?? "";
    },
    onSuccess: (nextSaved) => {
      toast.success(
        nextSaved.length > 0
          ? t("settings.ai.aboutMe.savedToast")
          : t("settings.ai.aboutMe.clearedToast"),
      );
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
    },
    onError: () => {
      toast.error(t("settings.ai.aboutMe.saveError"));
    },
  });

  return (
    <section
      aria-labelledby="settings-ai-about-me-title"
      data-testid="settings-about-me-card"
      className="bg-card border-border space-y-4 rounded-xl border p-6"
    >
      <SettingsCardHeader
        icon={NotebookPen}
        title={t("settings.ai.aboutMe.title")}
        titleId="settings-ai-about-me-title"
        description={t("settings.ai.aboutMe.description")}
      />

      <textarea
        data-testid="settings-about-me-textarea"
        className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-36 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
        value={value}
        maxLength={maxChars}
        placeholder={t("settings.ai.aboutMe.placeholder")}
        disabled={!isAuthenticated || query.isLoading || save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={t("settings.ai.aboutMe.title")}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          data-testid="settings-about-me-count"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t("settings.ai.aboutMe.charCount", {
            used: value.length,
            max: maxChars,
          })}
        </p>
        <div className="flex items-center gap-2">
          {saved.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings-about-me-clear"
              disabled={!isAuthenticated || save.isPending}
              onClick={() => save.mutate("")}
            >
              <Trash2 className="size-4" aria-hidden />
              {t("settings.ai.aboutMe.clear")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            data-testid="settings-about-me-save"
            disabled={!isAuthenticated || save.isPending || !dirty}
            onClick={() => save.mutate(value)}
          >
            {save.isPending && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {t("settings.ai.aboutMe.save")}
          </Button>
        </div>
      </div>

      {query.isError && (
        <p role="status" aria-live="polite" className="text-destructive text-xs">
          {t("settings.ai.aboutMe.loadError")}
        </p>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.aboutMe.hint")}
      </p>
    </section>
  );
}
