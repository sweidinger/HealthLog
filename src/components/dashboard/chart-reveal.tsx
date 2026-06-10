"use client";

import { useCallback, useEffect, useState } from "react";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { cn } from "@/lib/utils";

/**
 * v1.16.0 — shared reveal gate for the dashboard chart row.
 *
 * Pre-fix every chart cell popped in independently: the charts mount
 * together (once the snapshot resolves and the visibility gates flip),
 * but each one owns its own data query — `/api/mood/analytics` is a
 * single cheap read while the measurement charts fan out over
 * `/api/measurements?…`, so the mood chart reliably painted first and
 * the rest trickled in one after another. The maintainer flagged the
 * staggered pop-in as unprofessional.
 *
 * The gate keeps every chart MOUNTED from the start (so all data
 * queries fire in parallel) but visually holds each cell on its
 * layout-stable `<ChartSkeleton>` until either
 *
 *   1. every gated chart has reported its data query settled
 *      (`onDataReady` — the Promise.all moment), or
 *   2. the reveal timeout elapses (`CHART_REVEAL_TIMEOUT_MS`) so a
 *      single slow widget cannot hold the whole row hostage — the late
 *      chart simply finishes on its own skeleton-free cell afterwards.
 *
 * Both signals are monotonic: the ready-set only grows and the timeout
 * only fires once, so after the timeout window the reveal can never
 * regress even when a later mutation makes an additional chart visible.
 *
 * There is deliberately NO minimum delay: when every gated query is fast
 * the row reveals the moment the last one settles. The timeout is only
 * the worst-case cap on how long fast charts wait for the slowest
 * sibling — v1.16.1 lowered it 2 s → 1.2 s after the maintainer flagged
 * the dashboard as feeling slower: with warm caches most charts settle
 * in well under a second, and capping the hostage window at 1.2 s keeps
 * the synchronized reveal while shaving up to 800 ms of artificial wait
 * when one widget lags.
 */
export const CHART_REVEAL_TIMEOUT_MS = 1_200;

/**
 * Pure resolver behind `useDashboardChartReveal` — exported so the gate
 * logic has direct unit coverage without mounting the page (project
 * convention: SSR-only tests, no DOM test runner).
 */
export function resolveChartRevealState(input: {
  expectedIds: readonly string[];
  readyIds: ReadonlySet<string>;
  timedOut: boolean;
}): boolean {
  // Not armed yet — the chart gates only flip once the primary
  // dashboard query resolves, so an empty id list means there is
  // nothing to reveal (and nothing rendered that could need it).
  if (input.expectedIds.length === 0) return false;
  if (input.timedOut) return true;
  return input.expectedIds.every((id) => input.readyIds.has(id));
}

export function useDashboardChartReveal(
  expectedIds: readonly string[],
  timeoutMs: number = CHART_REVEAL_TIMEOUT_MS,
): { revealed: boolean; markReady: (id: string) => void } {
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [timedOut, setTimedOut] = useState(false);

  // Arm the timeout fallback the moment the first chart id shows up
  // (i.e. when the primary query resolved and the chart row mounts).
  // The timer deliberately runs to completion even when every chart
  // reports ready earlier — a fired `timedOut` latches the reveal open
  // so a chart that becomes visible later (e.g. the first mood entry
  // logged via quick-add) cannot flip the whole row back to skeletons.
  const armed = expectedIds.length > 0;
  useEffect(() => {
    if (!armed) return undefined;
    const handle = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(handle);
  }, [armed, timeoutMs]);

  // Idempotent — re-marking a ready id returns the same Set reference
  // so the repeated `onDataReady` calls from re-rendered charts never
  // cause a render loop.
  const markReady = useCallback((id: string) => {
    setReadyIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return {
    revealed: resolveChartRevealState({ expectedIds, readyIds, timedOut }),
    markReady,
  };
}

/**
 * One reveal-gated chart cell. The chart stays mounted underneath
 * (`visibility: hidden` keeps its layout box, so Recharts'
 * `ResponsiveContainer` measures real dimensions and the cell height
 * never jumps at reveal time) while a `<ChartSkeleton>` overlays the
 * exact same box. On reveal every cell swaps in the same frame with a
 * short fade-in; `motion-safe:` keeps the swap instant for
 * reduced-motion users.
 */
export function DashboardChartCell({
  revealed,
  children,
}: {
  revealed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative"
      data-slot="dashboard-chart-cell"
      data-revealed={revealed ? "true" : "false"}
    >
      <div
        aria-hidden={revealed ? undefined : true}
        className={cn(
          // `space-y-2` preserves the chart-row rhythm the dashboard's
          // outer cell applied when chart + TrendHint were direct
          // siblings (pre-gate markup).
          "space-y-2",
          revealed
            ? "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
            : "invisible",
        )}
      >
        {children}
      </div>
      {!revealed && (
        <ChartSkeleton className="absolute inset-0 overflow-hidden" />
      )}
    </div>
  );
}
