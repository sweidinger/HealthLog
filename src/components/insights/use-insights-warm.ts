"use client";

import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";

/**
 * On-demand full assessment warm.
 *
 * POSTs `/api/insights/pregenerate`, which enqueues a forced warm of every
 * AI assessment (comprehensive insight + the seven specialised status cards
 * + every data-bearing generic metric assessment) for the calling user on
 * the worker and returns immediately. The cards then fill via their existing
 * stale-while-revalidate GETs — there is nothing to invalidate here.
 *
 * This is the explicit "prepare assessments" button only. There is no
 * warm-on-mount: the nightly cron (04:30 Europe/Berlin) keeps every user's
 * caches warm, and the per-metric status GETs revalidate gently on their
 * own — so a page visit reads cached text instead of fanning out a full
 * provider warm that would contend with foreground requests.
 */

async function postWarm(): Promise<void> {
  // Same-origin relative-path fetch — exempt from the safe-fetch rule by
  // construction. A 429 (warm already in progress) is an expected,
  // harmless outcome, not an error.
  const res = await fetch("/api/insights/pregenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 429) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export interface UseInsightsWarmResult {
  /** Manual trigger — POSTs the warm and shows a toast. */
  warm: () => void;
  /** True while the warm POST is in flight. */
  isWarming: boolean;
}

export function useInsightsWarm(): UseInsightsWarmResult {
  const { t } = useTranslations();

  const mutation = useMutation({
    mutationKey: queryKeys.insightsPregenerate(),
    mutationFn: postWarm,
  });

  const { mutate } = mutation;

  const warm = useCallback(() => {
    mutate(undefined, {
      onSuccess: () => toast.success(t("insights.warmStarted")),
    });
  }, [mutate, t]);

  return {
    warm,
    isWarming: mutation.isPending,
  };
}
