"use client";

/**
 * v1.11.2 — Settings → AI "What the Coach remembers" panel.
 *
 * Surfaces the durable `CoachFact` rows the assistant has stored about
 * the user (the v1.11.1 routes already ship the data), grouped by
 * category, each with a relative "learned <when>" stamp and a "forget"
 * control. A bulk "forget everything" action clears the lot.
 *
 *   GET    /api/insights/coach/facts        → { data: { facts: [...] } }
 *   DELETE /api/insights/coach/facts/{id}   → { data: { deleted } }
 *   DELETE /api/insights/coach/facts        → { data: { cleared } }
 *
 * Reads unwrap `(await res.json()).data` per the envelope convention;
 * every read/write routes its key through `queryKeys.coachFacts()` so
 * a forget invalidates the list. Gated on `!user.disableCoach` so the
 * panel mirrors the rest of the Coach surface — hiding the Coach hides
 * its memory controls too.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatDateOrRelative } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";

/** Closed enum mirrored from the server `CoachFact.category` column. */
const FACT_CATEGORIES = [
  "preference",
  "condition",
  "goal",
  "constraint",
  "context",
] as const;
type FactCategory = (typeof FACT_CATEGORIES)[number];

interface CoachFact {
  id: string;
  category: FactCategory;
  text: string;
  confidence: number;
  createdAt: string;
}

const CATEGORY_LABEL_KEY: Record<FactCategory, string> = {
  preference: "settings.ai.coachMemory.categoryPreference",
  condition: "settings.ai.coachMemory.categoryCondition",
  goal: "settings.ai.coachMemory.categoryGoal",
  constraint: "settings.ai.coachMemory.categoryConstraint",
  context: "settings.ai.coachMemory.categoryContext",
};

async function fetchFacts(): Promise<CoachFact[]> {
  const res = await fetch("/api/insights/coach/facts");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: { facts?: CoachFact[] } };
  return json.data?.facts ?? [];
}

export function CoachMemorySection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.coachFacts(),
    queryFn: fetchFacts,
    enabled: isAuthenticated,
  });

  const forgetOne = useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/insights/coach/facts/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return id;
    },
    onSuccess: () => {
      toast.success(t("settings.ai.coachMemory.forgotToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => {
      toast.error(t("settings.ai.coachMemory.forgotError"));
    },
  });

  const forgetAll = useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async () => {
      const res = await fetch("/api/insights/coach/facts", {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: { cleared?: number } };
      return json.data?.cleared ?? 0;
    },
    onSuccess: (cleared) => {
      toast.success(
        t("settings.ai.coachMemory.clearedToast", { count: cleared }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => {
      toast.error(t("settings.ai.coachMemory.clearError"));
    },
  });

  const facts = useMemo(() => query.data ?? [], [query.data]);

  // Group by category in the canonical category order so the panel
  // reads the same way every render regardless of insertion order.
  const grouped = useMemo(() => {
    return FACT_CATEGORIES.map((category) => ({
      category,
      items: facts.filter((f) => f.category === category),
    })).filter((g) => g.items.length > 0);
  }, [facts]);

  return (
    <section
      aria-labelledby="settings-ai-coach-memory-title"
      data-testid="settings-coach-memory-card"
      className="bg-card border-border space-y-4 rounded-xl border p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="pr-2">
          <h2
            id="settings-ai-coach-memory-title"
            className="text-base font-semibold"
          >
            {t("settings.ai.coachMemory.title")}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("settings.ai.coachMemory.description")}
          </p>
        </div>
        {facts.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="settings-coach-memory-forget-all"
                disabled={!isAuthenticated || forgetAll.isPending}
              >
                {forgetAll.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
                {t("settings.ai.coachMemory.forgetAll")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.ai.coachMemory.forgetAllConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.ai.coachMemory.forgetAllConfirmBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("settings.ai.coachMemory.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="settings-coach-memory-forget-all-confirm"
                  onClick={() => forgetAll.mutate()}
                >
                  {t("settings.ai.coachMemory.forgetAllConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {query.isError && (
        <p role="status" aria-live="polite" className="text-destructive text-xs">
          {t("settings.ai.coachMemory.loadError")}
        </p>
      )}

      {!query.isError && facts.length === 0 ? (
        <p
          data-testid="settings-coach-memory-empty"
          className="text-muted-foreground text-sm"
        >
          {t("settings.ai.coachMemory.empty")}
        </p>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <div key={group.category} className="space-y-2">
              <h3
                data-testid={`settings-coach-memory-group-${group.category}`}
                className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
              >
                {t(CATEGORY_LABEL_KEY[group.category])}
              </h3>
              <ul className="space-y-2">
                {group.items.map((fact) => (
                  <li
                    key={fact.id}
                    data-testid="settings-coach-memory-fact"
                    className="border-border bg-background flex items-start justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm break-words">{fact.text}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t("settings.ai.coachMemory.learnedPrefix", {
                          when: formatDateOrRelative(fact.createdAt, t),
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="settings-coach-memory-forget"
                      aria-label={t("settings.ai.coachMemory.forgetAria")}
                      disabled={!isAuthenticated || forgetOne.isPending}
                      onClick={() => forgetOne.mutate(fact.id)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {t("settings.ai.coachMemory.forget")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.coachMemory.summaryNote")}
      </p>
    </section>
  );
}
