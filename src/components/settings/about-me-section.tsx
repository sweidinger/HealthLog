"use client";

/**
 * v1.15.20 — Settings → AI "About me" panel (free text only).
 * v1.16.0 — structured self-context: alongside the free text the user
 * answers three short questions (chronic conditions, allergies /
 * intolerances, what the Coach should watch). All four fields are
 * encrypted at rest; age/gender stay on the profile and are merged
 * into the prompt server-side — the panel says so instead of asking
 * again.
 *
 *   GET /api/coach/about-me — full structured payload + pending questions
 *   PUT /api/coach/about-me — writes all four fields (empty string clears)
 *
 * After a save the server derives up to 3 clarifying questions (AI
 * when a provider + budget allow, deterministic hints otherwise); the
 * panel surfaces them in a quiet callout and the Coach composer
 * renders them as tappable chips.
 *
 * Plain text only — every value renders exclusively through inputs and
 * React text children; no markdown anywhere.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  MessageCircleQuestion,
  NotebookPen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

const FALLBACK_MAX_CHARS = 4000;
const FALLBACK_FIELD_MAX_CHARS = 500;

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  pendingQuestions: string[];
  updatedAt: string | null;
  maxChars: number;
  fieldMaxChars: number;
}

type StructuredKey = "conditions" | "allergies" | "coachFocus";

async function fetchAboutMe(): Promise<AboutMeData> {
  return apiGet<AboutMeData>("/api/coach/about-me");
}

const FIELD_CLASSES =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none";

export function AboutMeSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<{
    aboutMe: string | null;
    conditions: string | null;
    allergies: string | null;
    coachFocus: string | null;
  }>({ aboutMe: null, conditions: null, allergies: null, coachFocus: null });

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: fetchAboutMe,
    enabled: isAuthenticated,
  });

  const saved = {
    aboutMe: query.data?.aboutMe ?? "",
    conditions: query.data?.conditions ?? "",
    allergies: query.data?.allergies ?? "",
    coachFocus: query.data?.coachFocus ?? "",
  };
  const maxChars = query.data?.maxChars ?? FALLBACK_MAX_CHARS;
  const fieldMaxChars = query.data?.fieldMaxChars ?? FALLBACK_FIELD_MAX_CHARS;
  const pendingQuestions = query.data?.pendingQuestions ?? [];

  const value = {
    aboutMe: drafts.aboutMe ?? saved.aboutMe,
    conditions: drafts.conditions ?? saved.conditions,
    allergies: drafts.allergies ?? saved.allergies,
    coachFocus: drafts.coachFocus ?? saved.coachFocus,
  };
  const dirty =
    value.aboutMe !== saved.aboutMe ||
    value.conditions !== saved.conditions ||
    value.allergies !== saved.allergies ||
    value.coachFocus !== saved.coachFocus;
  const hasAnyContent =
    saved.aboutMe.length > 0 ||
    saved.conditions.length > 0 ||
    saved.allergies.length > 0 ||
    saved.coachFocus.length > 0;

  // Quiet completeness meter: one segment per answered field. Reads
  // the SAVED state (not the draft) so it only moves on persistence.
  const answered = [
    saved.conditions,
    saved.allergies,
    saved.coachFocus,
    saved.aboutMe,
  ].filter((v) => v.length > 0).length;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    mutationFn: async (input: {
      aboutMe: string;
      conditions: string;
      allergies: string;
      coachFocus: string;
    }) => {
      return apiPut<AboutMeData>("/api/coach/about-me", input);
    },
    onSuccess: (next) => {
      const cleared =
        !next.aboutMe &&
        !next.conditions &&
        !next.allergies &&
        !next.coachFocus;
      toast.success(
        cleared
          ? t("settings.ai.aboutMe.clearedToast")
          : t("settings.ai.aboutMe.savedToast"),
      );
      setDrafts({
        aboutMe: null,
        conditions: null,
        allergies: null,
        coachFocus: null,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
    },
    onError: () => {
      toast.error(t("settings.ai.aboutMe.saveError"));
    },
  });

  const disabled = !isAuthenticated || query.isLoading || save.isPending;

  function structuredField(
    key: StructuredKey,
    label: string,
    placeholder: string,
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`settings-about-me-${key}`}>{label}</Label>
        <textarea
          id={`settings-about-me-${key}`}
          data-testid={`settings-about-me-${key}`}
          className={cn(FIELD_CLASSES, "min-h-16 resize-y")}
          rows={2}
          value={value[key]}
          maxLength={fieldMaxChars}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <section
      aria-labelledby="settings-ai-about-me-title"
      data-testid="settings-about-me-card"
      className="bg-card border-border space-y-5 rounded-xl border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsCardHeader
          icon={NotebookPen}
          title={t("settings.ai.aboutMe.title")}
          titleId="settings-ai-about-me-title"
          description={t("settings.ai.aboutMe.description")}
        />
        {/* Completeness — four quiet segments, no percentage shouting. */}
        <div
          className="flex items-center gap-1.5"
          aria-label={t("settings.ai.aboutMe.completeness", {
            answered,
            total: 4,
          })}
          title={t("settings.ai.aboutMe.completeness", {
            answered,
            total: 4,
          })}
        >
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              aria-hidden="true"
              className={cn(
                "h-1 w-5 rounded-full transition-colors",
                i < answered ? "bg-dracula-purple" : "bg-border",
              )}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-4 pl-7 sm:grid-cols-2">
        {structuredField(
          "conditions",
          t("settings.ai.aboutMe.conditionsLabel"),
          t("settings.ai.aboutMe.conditionsPlaceholder"),
        )}
        {structuredField(
          "allergies",
          t("settings.ai.aboutMe.allergiesLabel"),
          t("settings.ai.aboutMe.allergiesPlaceholder"),
        )}
        <div className="sm:col-span-2">
          {structuredField(
            "coachFocus",
            t("settings.ai.aboutMe.focusLabel"),
            t("settings.ai.aboutMe.focusPlaceholder"),
          )}
        </div>
      </div>

      <div className="space-y-1.5 pl-7">
        <Label htmlFor="settings-about-me-freetext">
          {t("settings.ai.aboutMe.freeTextLabel")}
        </Label>
        <textarea
          id="settings-about-me-freetext"
          data-testid="settings-about-me-textarea"
          className={cn(FIELD_CLASSES, "min-h-36 resize-y")}
          value={value.aboutMe}
          maxLength={maxChars}
          placeholder={t("settings.ai.aboutMe.placeholder")}
          disabled={disabled}
          onChange={(e) =>
            setDrafts((d) => ({ ...d, aboutMe: e.target.value }))
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pl-7">
        <p
          data-testid="settings-about-me-count"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t("settings.ai.aboutMe.charCount", {
            used: value.aboutMe.length,
            max: maxChars,
          })}
        </p>
        <div className="flex items-center gap-2">
          {hasAnyContent && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings-about-me-clear"
              disabled={!isAuthenticated || save.isPending}
              onClick={() =>
                save.mutate({
                  aboutMe: "",
                  conditions: "",
                  allergies: "",
                  coachFocus: "",
                })
              }
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

      {pendingQuestions.length > 0 && (
        <div
          data-testid="settings-about-me-questions"
          className="border-dracula-purple/30 bg-dracula-purple/5 rounded-lg border p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <MessageCircleQuestion
              className="text-dracula-purple size-4 shrink-0"
              aria-hidden="true"
            />
            {t("settings.ai.aboutMe.questionsTitle")}
          </p>
          <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5 text-sm">
            {pendingQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs">
            <Link
              href="/insights/coach"
              className="text-dracula-purple underline-offset-4 hover:underline"
            >
              {t("settings.ai.aboutMe.questionsOpenCoach")}
            </Link>
          </p>
        </div>
      )}

      {query.isError && (
        <p
          role="status"
          aria-live="polite"
          className="text-destructive text-sm"
        >
          {t("settings.ai.aboutMe.loadError")}
        </p>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 pl-7 text-xs">
        {t("settings.ai.aboutMe.hint")} {t("settings.ai.aboutMe.profileHint")}
      </p>
    </section>
  );
}
