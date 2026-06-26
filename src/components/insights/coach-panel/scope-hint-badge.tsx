"use client";

import { Sparkles, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.22.0 (A2 + A3) — the Coach's visible scope/opener affordance.
 *
 * Two modes, one surface:
 *
 *  - **scope** (A2): the Coach was launched narrowed to a metric (from a
 *    metric page or an insight card). Instead of the old hidden composer
 *    prefill, render a small pill — "The Coach is already on <metric>" —
 *    plus a tappable seed question that drops the data-aware opener into
 *    the composer / sends it. This turns the built-but-invisible scope
 *    plumbing into the core ambient feeling.
 *
 *  - **seeded** (A3): the Coach opened UNSCOPED (the blank hero) and the
 *    server surfaced today's single most notable derived signal. Render it
 *    as a tappable suggested opener so the blank box is never cold. When no
 *    signal crosses the gate the caller renders nothing and the neutral
 *    greeting stands — there is no fake opener.
 *
 * Presentational + self-contained: the parent supplies the resolved label
 * and the seed question, and an `onSeed` callback wired to the composer.
 * The badge owns no data fetching.
 */
export interface ScopeHintBadgeProps {
  /**
   * Which affordance this is. `scope` shows the "already on <metric>" pill;
   * `seeded` shows the notable-signal opener. Drives the icon + the prefix
   * copy only — the tappable seed question is shared.
   */
  variant: "scope" | "seeded";
  /**
   * The visible metric / signal label, already resolved to the user's
   * locale by the caller (e.g. "blood pressure", "readiness").
   */
  label: string;
  /** The tappable seed question — the data-aware opener. */
  question: string;
  /** Fired with the seed question when the user taps the opener. */
  onSeed: (question: string) => void;
  className?: string;
}

export function ScopeHintBadge({
  variant,
  label,
  question,
  onSeed,
  className,
}: ScopeHintBadgeProps) {
  const { t } = useTranslations();

  const Icon = variant === "scope" ? Target : Sparkles;
  const prefix =
    variant === "scope"
      ? t("insights.coach.scope.prefix", { metric: label })
      : t("insights.coach.seeded.prefix", { signal: label });

  return (
    <div
      data-slot="coach-scope-hint"
      data-variant={variant}
      className={cn("flex w-full flex-col items-center gap-2.5", className)}
    >
      {/* The scope/signal pill — the visible "already on …" line. */}
      <span
        data-slot="coach-scope-hint-pill"
        className={cn(
          "border-border/60 bg-muted/40 text-muted-foreground",
          "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1",
          "text-xs font-medium",
        )}
      >
        <Icon
          className="text-dracula-purple size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="truncate">{prefix}</span>
      </span>

      {/* The tappable seed question — the data-aware opener. A real button so
          keyboard + screen-reader users get the same affordance. */}
      <button
        type="button"
        data-slot="coach-scope-hint-seed"
        onClick={() => onSeed(question)}
        className={cn(
          "group border-border/70 bg-background hover:bg-muted/50 text-foreground",
          "flex w-full max-w-md items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left",
          "transition-colors",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        <span className="min-w-0 flex-1 text-sm leading-snug">{question}</span>
        <span
          aria-hidden="true"
          className="text-muted-foreground group-hover:text-foreground text-xs whitespace-nowrap"
        >
          {t("insights.coach.scope.tap")}
        </span>
      </button>
    </div>
  );
}
