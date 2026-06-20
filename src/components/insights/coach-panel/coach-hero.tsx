"use client";

import { Quote, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.18.9 — the Coach new-chat hero (page surface only).
 *
 * A centred greeting with the composer directly beneath it and a row of
 * HealthLog's own starter questions, floated in generous negative space
 * over a faint purple atmospheric backdrop. This replaces the cramped
 * bottom-pinned empty thread with a calm, ChatGPT/Claude-grade prompt
 * surface. On first send the conversation branch takes over and the
 * composer docks to the bottom (handled by `<CoachConversation>`).
 *
 * The hero does NOT fork composer logic: it RECEIVES the live
 * `<CoachInput>` as the `composer` slot, so dictation, auto-grow, the
 * send/stop control, and the guided-question placeholder all behave
 * exactly as in the docked composer. The suggestion chips seed the same
 * composer via `onPickPrompt`.
 *
 * Motion: one orchestrated reveal — sparkle → greeting → composer → chips
 * stagger in via `motion-safe` `animate-in` with capped delays;
 * reduced-motion users get the layout instantly.
 */
export interface CoachHeroProps {
  /** The live `<CoachInput>` composer, re-parented into the hero. */
  composer: React.ReactNode;
  /** Localised starter prompts shown as chips below the composer. */
  prompts: string[];
  /** Seeds the composer with a chip's text (the parent submits on pick). */
  onPickPrompt: (prompt: string) => void;
}

export function CoachHero({ composer, prompts, onPickPrompt }: CoachHeroProps) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="coach-hero"
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-8 sm:px-6"
    >
      {/* Atmospheric backdrop — a faint purple radial glow behind the
          hero, never busy. Pointer-events-none + aria-hidden so it is
          purely decorative; it sits behind the content via -z-10. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 -z-10",
          "bg-[radial-gradient(60%_50%_at_50%_38%,color-mix(in_srgb,var(--dracula-purple)_14%,transparent),transparent_70%)]",
        )}
      />

      <div className="flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        {/* Sparkle mark */}
        <div
          aria-hidden="true"
          className={cn(
            "from-dracula-purple to-dracula-pink flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br shadow-sm",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500",
          )}
        >
          <Sparkles className="text-background size-6" />
        </div>

        {/* Greeting — a slightly larger, tighter display treatment of the
            existing font (weight/tracking/size only, no new font). */}
        <div
          className={cn(
            "flex flex-col gap-1.5",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
          )}
          style={{ animationDelay: "80ms", animationFillMode: "both" }}
        >
          <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("insights.coach.heroGreeting")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("insights.coach.heroSubline")}
          </p>
        </div>

        {/* Composer — the live <CoachInput>, centred. */}
        <div
          data-slot="coach-hero-composer"
          className={cn(
            "w-full",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
          )}
          style={{ animationDelay: "160ms", animationFillMode: "both" }}
        >
          {composer}
        </div>

        {/* Starter-question chips, seeded with the Coach's own prompts. */}
        {prompts.length > 0 && (
          <div
            data-slot="coach-hero-chips"
            className={cn(
              "flex flex-wrap items-center justify-center gap-2",
              "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500",
            )}
            style={{ animationDelay: "240ms", animationFillMode: "both" }}
          >
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onPickPrompt(prompt)}
                data-slot="coach-hero-chip"
                title={prompt}
                className={cn(
                  "border-dracula-purple/20 hover:border-dracula-purple/45 hover:text-foreground",
                  "text-muted-foreground inline-flex min-h-11 max-w-full items-center gap-1.5 sm:min-h-9 sm:max-w-[18rem]",
                  "rounded-full border bg-transparent px-3.5 py-1.5 text-xs sm:text-sm",
                  "transition-colors focus-visible:ring-2 focus-visible:outline-none",
                  "focus-visible:ring-dracula-purple/50",
                )}
              >
                <Quote className="size-3 shrink-0" aria-hidden="true" />
                {/* Cap the chip to a tidy single line — long localized prompts
                    (notably DE) otherwise wrap to ragged multi-line pills on a
                    narrow viewport. The full prompt stays available via title. */}
                <span className="truncate">{prompt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
