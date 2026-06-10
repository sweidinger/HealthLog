"use client";

/**
 * v1.16.0 — pending self-context questions as composer chips.
 *
 * After the user saves Settings → AI → "About me", the server derives
 * up to 3 clarifying questions (`/api/coach/about-me/questions`). They
 * surface here, directly above the Coach composer, as quiet tappable
 * chips: tapping one inserts the question into the composer (so the
 * user answers it in their own words) and dismisses it; the ✕
 * dismisses without inserting. No questions → nothing renders, zero
 * vertical cost.
 *
 * Each chip is a `role="group"` of two sibling buttons (insert +
 * dismiss) — buttons cannot nest, and both actions deserve their own
 * focus stop.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleQuestion, X } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export interface SelfContextChipsProps {
  /** Insert the tapped question into the composer. */
  onPick: (question: string) => void;
  /** Hidden while a reply streams so the input value cannot be yanked. */
  disabled?: boolean;
}

export function SelfContextChips({
  onPick,
  disabled = false,
}: SelfContextChipsProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.coachAboutMeQuestions(),
    queryFn: async () => {
      const res = await fetch("/api/coach/about-me/questions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).data as { questions: string[] };
    },
    staleTime: 60_000,
  });

  const dismiss = useMutation({
    mutationKey: queryKeys.coachAboutMeQuestions(),
    mutationFn: async (question: string) => {
      const res = await fetch("/api/coach/about-me/questions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).data as { questions: string[] };
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.coachAboutMeQuestions(), next);
    },
  });

  const questions = data?.questions ?? [];
  if (questions.length === 0) return null;

  return (
    <div data-slot="coach-self-context-chips" className="mb-2">
      <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[11px]">
        <MessageCircleQuestion
          className="text-dracula-purple size-3.5 shrink-0"
          aria-hidden="true"
        />
        {t("insights.coach.selfContextChipsLabel")}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {questions.map((question) => (
          <li
            key={question}
            role="group"
            aria-label={question}
            className={cn(
              "border-dracula-purple/30 bg-dracula-purple/10 inline-flex max-w-full items-stretch overflow-hidden rounded-full border",
              "transition-colors",
            )}
          >
            <button
              type="button"
              disabled={disabled}
              data-slot="coach-self-context-chip"
              onClick={() => {
                onPick(question);
                dismiss.mutate(question);
              }}
              title={question}
              className={cn(
                "text-foreground min-h-9 min-w-0 truncate py-1.5 pr-1 pl-3 text-left text-xs",
                "hover:bg-dracula-purple/15 focus-visible:ring-dracula-purple/40 focus-visible:ring-2 focus-visible:outline-none",
                "disabled:opacity-60",
              )}
            >
              {question}
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-label={t("insights.coach.selfContextChipDismiss")}
              data-slot="coach-self-context-chip-dismiss"
              onClick={() => dismiss.mutate(question)}
              className={cn(
                "text-muted-foreground hover:text-foreground flex items-center px-2",
                "hover:bg-dracula-purple/15 focus-visible:ring-dracula-purple/40 focus-visible:ring-2 focus-visible:outline-none",
                "disabled:opacity-60",
              )}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
