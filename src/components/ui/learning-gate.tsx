import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * v1.17.1 — the one "we're still learning your X" gate.
 *
 * Before this primitive, glucose, sleep-debt, chronotype, the trajectory
 * forecast, and the composite-score anatomy each hand-rolled the warm
 * "not enough data yet" paragraph — five copies with different markers,
 * different `data-slot` values, and no shared a11y contract. The calm
 * voice held only because each author copied the tone by hand, which is
 * exactly the drift that bites the next metric author.
 *
 * `LearningGate` owns the *presentation and behaviour* of a learning
 * state — the muted body paragraph, an optional secondary caveat line,
 * the `data-state="learning"` marker, and the polite live region — while
 * the caller passes the metric-specific localized copy and keeps its own
 * card title / icon chrome. One look, one behaviour, copy still per-metric.
 *
 * Variants:
 *   - `"inline"` (default): a bare muted paragraph for use INSIDE a card
 *     that already has its own header (glucose / sleep / trajectory).
 *   - `"bordered"`: a dashed-border centered note for STANDALONE use where
 *     there is no surrounding card chrome (score anatomy).
 */
export interface LearningGateProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  /** Localized primary "still learning" sentence. */
  message: React.ReactNode;
  /** Optional secondary line — a caveat or a "N more days" nudge. */
  caveat?: React.ReactNode;
  variant?: "inline" | "bordered";
  /** Compact density for tiles / narrow rails. */
  compact?: boolean;
  /**
   * Optional override for the body `data-slot`, so existing per-surface
   * test selectors (e.g. `glucose-learning-body`,
   * `trajectory-insufficient`, `score-anatomy-insufficient`) keep
   * resolving after the repoint.
   */
  bodySlot?: string;
}

export function LearningGate({
  message,
  caveat,
  variant = "inline",
  compact = false,
  bodySlot,
  className,
  ...props
}: LearningGateProps) {
  const body = (
    <p
      data-slot={bodySlot ?? "learning-gate-body"}
      className={cn(
        "text-muted-foreground",
        compact ? "text-xs leading-snug" : "text-sm",
        variant === "bordered" && "text-center text-xs",
      )}
    >
      {message}
    </p>
  );

  return (
    <div
      data-slot="learning-gate"
      data-state="learning"
      role="status"
      aria-live="polite"
      className={cn(
        "space-y-2",
        variant === "bordered" && "rounded-lg border border-dashed px-4 py-6",
        className,
      )}
      {...props}
    >
      {body}
      {caveat ? (
        <p
          data-slot="learning-gate-caveat"
          className="text-muted-foreground/80 text-xs leading-snug"
        >
          {caveat}
        </p>
      ) : null}
    </div>
  );
}
