"use client";

import { Component, type ReactElement, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Error-state card + per-chart error boundary.
 *
 * Two failure classes used to look like something else:
 *   - A failed data query fell into the "no data in this range" empty
 *     state (the queries swallowed per-type failures as empty success),
 *     so an outage read as "you have no measurements".
 *   - A rejected lazy chunk import (stale shell after a deploy) bubbled
 *     to the route-level `error.tsx` and replaced the WHOLE page.
 *
 * `<ChartErrorState>` is the shared presentational card — same dashed
 * footprint as `<ChartEmptyState>` so the dashboard layout never
 * reflows — with a compact action button. `<ChartErrorBoundary>` wraps
 * each lazy chart mount so a failed chunk degrades to one card with a
 * reload affordance instead of taking the page down.
 */

export interface ChartErrorStateProps {
  /** Translated headline, e.g. "Data could not be loaded". */
  title: string;
  /** Translated action-button label, e.g. "Retry". */
  actionLabel: string;
  /** Action handler — query `refetch` or a full page reload. */
  onAction: () => void;
  /**
   * Optional explicit height in pixels to match the surrounding chart
   * card. Defaults to 240 (matches `<ChartEmptyState>`).
   */
  height?: number;
}

export function ChartErrorState({
  title,
  actionLabel,
  onAction,
  height = 240,
}: ChartErrorStateProps): ReactElement {
  return (
    <div
      data-slot="chart-error-state"
      className="border-border/40 bg-muted/10 text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 text-center"
      style={{ height }}
    >
      <AlertTriangle
        className="text-muted-foreground/60 h-8 w-8"
        aria-hidden="true"
      />
      <p className="text-sm font-medium">{title}</p>
      <Button variant="outline" size="sm" onClick={onAction}>
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        {actionLabel}
      </Button>
    </div>
  );
}

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // Surface to the client-side error tracker the same way the
    // route-level boundary does — the card degrades quietly but the
    // failure still lands in monitoring.
    if (typeof window !== "undefined") {
      const g = window as typeof window & {
        __healthlog_onError?: (err: Error) => void;
      };
      g.__healthlog_onError?.(error);
    }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Per-card boundary for lazy chart mounts. A chunk that still rejects
 * after the `importWithRetry` attempt (see `src/lib/retry-import.ts`)
 * renders this card instead of bubbling to the route boundary; the
 * reload affordance fetches the fresh shell + chunk graph (a rejected
 * lazy import is cached, so a remount alone cannot recover).
 */
export function ChartErrorBoundary({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslations();
  return (
    <Boundary
      fallback={
        <ChartErrorState
          title={t("charts.loadErrorTitle")}
          actionLabel={t("charts.loadErrorReload")}
          onAction={() => window.location.reload()}
        />
      }
    >
      {children}
    </Boundary>
  );
}
