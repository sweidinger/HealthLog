"use client";

import { Quote } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";
import { cn } from "@/lib/utils";

/**
 * v1.4.20 phase B1 — "Try asking" prompt-chip strip.
 *
 * Renders a horizontal row of clickable prompt chips below the hero
 * action band. Each chip is a single i18n string; clicking a chip
 * invokes `onPick` with the localised string so the parent can route
 * to the future Coach drawer (B2) or pre-fill an input.
 *
 * Mobile-first: chips wrap to multiple rows on narrow viewports.
 *
 * The default 5-chip ordering mirrors the design handoff
 * (`prototype/artboard-fullpage.jsx → BriefingHero` quick-prompts
 * row). Each label lives in `messages/{en,de}.json` under
 * `insights.suggestedPrompts.<key>` so the parent stays Locale-
 * agnostic.
 */
export interface SuggestedPromptsProps {
  /**
   * Override the default prompt list. When omitted, the component
   * resolves the two defaults from `insights.suggestedPrompts.*`.
   * Useful for tests + future per-user prompt sets.
   */
  prompts?: string[];
  /** Click handler — receives the localised prompt string. */
  onPick: (prompt: string) => void;
  /** Optional className passthrough for layout overrides. */
  className?: string;
}

// v1.12.4 — trimmed from five speculative prompts to the two that read as a
// clear next step: ask what to tell the doctor, and whether the medication is
// working. The data-specific openers ("why was Monday higher", weight × pulse,
// week vs month) were guesses that did not always match the user's own log.
const DEFAULT_PROMPT_KEYS = ["tellMyDoctor", "medicationWorking"] as const;

export function SuggestedPrompts({
  prompts,
  onPick,
  className,
}: SuggestedPromptsProps) {
  const { t } = useTranslations();
  // v1.4.37 W5 — every chip is a Coach affordance: clicking one seeds
  // the Coach drawer's composer and opens it. When the operator turns
  // the global Coach flag off the strip must vanish along with the
  // hero action button and the drawer mount. The HeroStrip caller
  // already guards on `flags.coach`; the in-component gate is
  // defence-in-depth so a future caller that mounts <SuggestedPrompts>
  // outside the hero band can never leak a Coach surface.
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();
  if (!flags.coach) return null;
  // v1.4.47 W3 — per-user opt-out hides every Coach affordance,
  // including the suggested-prompts chip strip. Same posture as the
  // FAB / drawer / inline pill gate above.
  if (disableCoach) return null;
  const items =
    prompts ??
    DEFAULT_PROMPT_KEYS.map((key) => t(`insights.suggestedPrompts.${key}`));

  return (
    <div
      data-slot="insights-suggested-prompts"
      // v1.8.5 W4a — tighten the chip row gutter (`gap-1.5` vs `gap-2`) so
      // the condensed Coach band reads as a dense, deliberate strip rather
      // than an airy wrap. The chips themselves shrink their padding below.
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      <span
        data-slot="insights-suggested-prompts-label"
        className="text-muted-foreground mr-1 text-xs font-medium tracking-wide uppercase"
      >
        {t("insights.suggestedPrompts.label")}
      </span>
      {items.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          data-slot="insights-suggested-prompts-chip"
          // v1.8.5 W4a — denser chips. The horizontal padding + type size
          // drop a notch so the two prompts pack into fewer rows and the
          // left column stops towering over the Health-Score card. The tap
          // target clears the 44 px iOS/WCAG floor on phones (`min-h-11`)
          // and relaxes to the denser 36 px from `sm` up.
          className={cn(
            "border-primary/18 hover:border-primary/40 hover:text-foreground",
            "text-muted-foreground inline-flex min-h-11 items-center gap-1.5 sm:min-h-9",
            "rounded-full border bg-transparent px-3 py-1.5 text-xs",
            "transition-colors focus-visible:ring-2 focus-visible:outline-none",
            "focus-visible:ring-primary/50",
          )}
        >
          <Quote className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{prompt}</span>
        </button>
      ))}
    </div>
  );
}
