"use client";

import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.16 phase B1b — Apple-Health-style page hero for `/insights`.
 *
 * Polished header band that frames the page below. Pure presentational —
 * the page passes timestamps + the regenerate handler in. Stays a thin
 * shell around the existing translation keys so a future redesign only
 * touches this file.
 *
 * Visual language:
 *   - subtle Dracula gradient background (purple → cyan, low opacity so
 *     dark-mode contrast is preserved against `var(--background)`)
 *   - sparkles glyph + heading + overview subtitle on the left
 *   - meta row underneath with personal-baseline indicator + the
 *     "Generated <relative-time>" caption when an updatedAt is supplied
 *   - regenerate button on the right (top-aligned on desktop, stacked
 *     under the meta row on mobile)
 *   - smooth fade-in via the existing `animate-insight-in` keyframes;
 *     `prefers-reduced-motion: reduce` already disables that animation
 *     globally (see globals.css §Insight card animations).
 *
 * Layout slots:
 *   - `data-slot="insights-page-hero"`              — outer wrapper
 *   - `data-slot="insights-page-hero-generated"`    — "Generated <time>"
 *   - `data-slot="insights-page-hero-baseline"`     — "Based on …"
 *   - `data-slot="insights-page-hero-regenerate"`   — regenerate button
 */

interface InsightsPageHeroProps {
  /** ISO-8601 timestamp of the last AI generation; controls the "Generated …" caption. */
  updatedAt?: string | null;
  /** Click handler for the regenerate button; omit to hide the control. */
  onRegenerate?: () => void;
  /** Disables the regenerate button + flips the icon to a spinner. */
  regenerating?: boolean;
}

/**
 * Format a relative time using the i18n translation keys. Avoids the
 * `Intl.RelativeTimeFormat` polyfill cost on the client AND keeps every
 * surface that renders relative times locked to the project's
 * established translation vocabulary.
 *
 * Buckets: <1min → just now; <60min → N min ago; <24h → N h ago;
 * else N days ago.
 */
function formatRelativeTime(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = Date.now() - target;
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t("insights.relativeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("insights.relativeHoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("insights.relativeDaysAgo", { count: days });
}

export function InsightsPageHero({
  updatedAt,
  onRegenerate,
  regenerating = false,
}: InsightsPageHeroProps) {
  const { t } = useTranslations();
  const generatedLine = updatedAt
    ? t("insights.heroGenerated", { time: formatRelativeTime(updatedAt, t) })
    : null;

  return (
    <div
      data-slot="insights-page-hero"
      className="border-dracula-purple/25 from-dracula-purple/15 via-dracula-cyan/8 animate-insight-in relative overflow-hidden rounded-xl border bg-gradient-to-br to-transparent px-4 py-5 sm:px-6 sm:py-6"
    >
      {/* Decorative sparkle glow — purely visual, kept inert for screen readers. */}
      <div
        aria-hidden="true"
        className="bg-dracula-purple/10 pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full blur-3xl"
      />
      <div
        aria-hidden="true"
        className="bg-dracula-cyan/10 pointer-events-none absolute -bottom-16 -left-10 h-36 w-36 rounded-full blur-3xl"
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <Sparkles
              className="text-dracula-purple h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <h1 className="text-2xl font-bold tracking-tight">
              {t("insights.title")}
            </h1>
          </div>
          <p className="text-muted-foreground text-sm leading-snug">
            {t("insights.overviewSubtitle")}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
            <span data-slot="insights-page-hero-baseline">
              {t("insights.heroPersonalBaseline")}
            </span>
            {generatedLine && (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <span data-slot="insights-page-hero-generated">
                  {generatedLine}
                </span>
              </>
            )}
          </div>
        </div>
        {onRegenerate && (
          <div className="flex shrink-0 items-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRegenerate}
              disabled={regenerating}
              data-slot="insights-page-hero-regenerate"
              className="gap-1.5"
            >
              {regenerating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>
                {regenerating
                  ? t("insights.heroRegenerating")
                  : t("insights.heroRegenerate")}
              </span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
