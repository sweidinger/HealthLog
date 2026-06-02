"use client";

import { useCallback, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.7.1 — on-demand full assessment warm.
 *
 * POSTs `/api/insights/pregenerate`, which enqueues a forced warm of every
 * AI assessment (comprehensive insight + the seven specialised status cards
 * + every data-bearing generic metric assessment) for the calling user on
 * the worker and returns immediately. The cards then fill via their existing
 * stale-while-revalidate GETs — there is nothing to invalidate here.
 *
 * Two entry points share the one mutation:
 *   - `warm()` — the manual "prepare assessments" button. Shows a toast.
 *   - `autoWarmOnce(enabled)` — a fire-and-forget background warm fired ONCE
 *     per browser session (sessionStorage-gated) when the Insights overview
 *     mounts with data, so a returning user lands on warm caches without
 *     tapping anything. The auto path is silent (no toast) and tolerates a
 *     blocked/failed request — the server-side anti-spam bucket and the
 *     nightly cron are the catch-net.
 */

const AUTO_WARM_SESSION_KEY = "healthlog:insights:auto-warm";

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
  /**
   * Fire the background warm once per session. Pass `enabled` (e.g.
   * authenticated AND the user has data) — the warm only fires on the
   * first call where `enabled` is true, and never again this session.
   */
  autoWarmOnce: (enabled: boolean) => void;
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

  // The auto-trigger must fire at most once per session even across the
  // remounts a route navigation causes. A ref guards within the mount;
  // sessionStorage guards across mounts / navigations.
  const firedThisMount = useRef(false);
  const autoWarmOnce = useCallback(
    (enabled: boolean) => {
      if (!enabled || firedThisMount.current) return;
      firedThisMount.current = true;
      try {
        if (window.sessionStorage.getItem(AUTO_WARM_SESSION_KEY)) return;
        window.sessionStorage.setItem(AUTO_WARM_SESSION_KEY, String(Date.now()));
      } catch {
        // sessionStorage can throw under strict-privacy modes — fall
        // through and fire the warm anyway; the server bucket de-dupes.
      }
      // Silent background warm — no toast, errors swallowed by the
      // mutation's default (no onError handler surfaces it).
      mutate();
    },
    [mutate],
  );

  return {
    warm,
    isWarming: mutation.isPending,
    autoWarmOnce,
  };
}
