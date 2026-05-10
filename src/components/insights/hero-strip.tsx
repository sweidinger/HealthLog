"use client";

import {
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SuggestedPrompts } from "./suggested-prompts";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * v1.4.20 phase B1 — Insights redesign hero strip.
 *
 * Replaces the v1.4.16 `<InsightsPageHero>` with the wider band from
 * the design handoff (`prototype/artboard-fullpage.jsx → BriefingHero`):
 *
 *   - locale-aware time-of-day greeting line ("Good morning, …" /
 *     "Guten Morgen, …") + a narrative subtitle (the briefing
 *     paragraph when one is cached, else a fallback)
 *   - personal-baseline + "Generated <relative-time>" meta row
 *   - 3-button action row: "Generate weekly report" (disabled, B4),
 *     "Ask the coach" (disabled, B2), "Re-run analysis" (wired to
 *     the existing regenerate handler from v1.4.16 D-reconcile)
 *   - <SuggestedPrompts> chip strip below the action band
 *   - Dracula gradient + soft purple glow via the new `.hero-gradient`
 *     + `.glow-purple` utilities in `globals.css`
 *
 * Mobile-first: the action row wraps + the suggested-prompt chips
 * wrap. Right-side Health Score panel is *not* part of B1 — that
 * lands in B5; for B1 the right side just keeps its meta band.
 *
 * Pure presentational — the page owns the briefing data + the
 * regenerate handler.
 */

interface HeroStripProps {
  /** Briefing payload — its paragraph drives the hero subtitle. */
  briefing: DailyBriefingPayload | null;
  /** ISO timestamp of the freshest cached payload. */
  updatedAt?: string | null;
  /**
   * Display name for the greeting; defaults to no-name greeting
   * ("Good morning,") when omitted so the hero never paints "Good
   * morning, undefined".
   */
  userName?: string | null;
  /** Click handler for the regenerate button — wired to the advisor query. */
  onRegenerate?: () => void;
  /** Disables the regenerate button + flips its icon to a spinner. */
  regenerating?: boolean;
  /**
   * Click handler for the suggested prompts. The Coach drawer (B2b)
   * routes a chip click into the drawer's input; the parent owns the
   * drawer state. When omitted the chip click is a no-op.
   */
  onPickPrompt?: (prompt: string) => void;
  /**
   * Click handler for the "Ask the coach" action button. When supplied,
   * the button is enabled and the coming-soon tooltip drops; clicking
   * opens the drawer (B2b). When omitted the button stays disabled —
   * see the v1.4.20 phase B1 dispatch where the drawer was deferred.
   */
  onAskCoach?: () => void;
  /**
   * Now() override for tests so the greeting bucket is deterministic.
   * Defaults to `new Date()`. Production callers omit this.
   */
  now?: Date;
}

/**
 * Bucketed time-of-day greeting:
 *   05:00–11:59 → morning
 *   12:00–17:59 → afternoon
 *   18:00–22:59 → evening
 *   23:00–04:59 → night (mapped to "evening" for both locales — it's
 *                        rare to see /insights at 03:00 and "Guten
 *                        Morgen" pre-5am reads odd)
 */
function resolveGreetingKey(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "insights.heroGreetingMorning";
  if (hour >= 12 && hour < 18) return "insights.heroGreetingAfternoon";
  if (hour >= 18 && hour < 23) return "insights.heroGreetingEvening";
  return "insights.heroGreetingNight";
}

/**
 * Bucketed relative-time using i18n translation keys so every surface
 * shares vocabulary. Mirrors the helper in `<InsightsPageHero>`.
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

export function HeroStrip({
  briefing,
  updatedAt,
  userName,
  onRegenerate,
  regenerating = false,
  onPickPrompt,
  onAskCoach,
  now,
}: HeroStripProps) {
  const { t } = useTranslations();
  const greetingKey = resolveGreetingKey(now ?? new Date());
  const greetingBase = t(greetingKey);
  const greeting = userName ? `${greetingBase}, ${userName}` : greetingBase;
  const subtitle = briefing?.paragraph ?? t("insights.heroFallbackSubtitle");
  const generatedLine = updatedAt
    ? t("insights.heroGenerated", { time: formatRelativeTime(updatedAt, t) })
    : null;
  const comingSoon = t("insights.heroComingSoonTooltip");

  return (
    <div
      data-slot="insights-hero-strip"
      className={cn(
        "hero-gradient glow-purple animate-insight-in",
        "relative overflow-hidden rounded-xl px-4 py-5 sm:px-6 sm:py-6",
      )}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Sparkles
              className="text-dracula-purple h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <h1
              data-slot="insights-hero-strip-greeting"
              className="text-2xl leading-tight font-semibold tracking-tight sm:text-[28px]"
            >
              {greeting}
            </h1>
          </div>
          <p
            data-slot="insights-hero-strip-subtitle"
            className="text-muted-foreground max-w-3xl text-sm leading-relaxed"
          >
            {subtitle}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span data-slot="insights-hero-strip-baseline">
              {t("insights.heroPersonalBaseline")}
            </span>
            {generatedLine && (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <span data-slot="insights-hero-strip-generated">
                  {generatedLine}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
           * v1.4.20 phase B4 ships the weekly-report route. Disabled
           * here so the affordance lives in the hero from B1 onwards
           * without dead links — title= surfaces the "Coming soon"
           * caption on hover/focus without dragging in a Radix
           * tooltip provider for a single static label.
           */}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled
            title={comingSoon}
            data-slot="insights-hero-strip-action-weekly-report"
            className="gap-1.5"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("insights.heroActionWeeklyReport")}</span>
          </Button>
          {/* B2b wires this into the Coach drawer. The button is
              enabled whenever the parent supplies an `onAskCoach`
              handler; older parents that haven't adopted B2b yet
              still get the disabled "Coming soon" affordance so the
              hero doesn't break. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAskCoach}
            disabled={!onAskCoach}
            title={onAskCoach ? undefined : comingSoon}
            data-slot="insights-hero-strip-action-coach"
            className="gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("insights.heroActionAskCoach")}</span>
          </Button>
          {onRegenerate && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRegenerate}
              disabled={regenerating}
              data-slot="insights-hero-strip-action-rerun"
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
                  : t("insights.heroActionRerun")}
              </span>
            </Button>
          )}
        </div>

        <div
          data-slot="insights-hero-strip-prompts"
          className="border-border/50 border-t pt-4"
        >
          {/*
           * v1.4.20 phase B2b — chip clicks open the Coach drawer
           * with the localised prompt pre-filled in the composer.
           * The parent owns drawer state so the chip strip stays
           * presentational.
           */}
          <SuggestedPrompts
            onPick={onPickPrompt ?? (() => undefined)}
          />
        </div>
      </div>
    </div>
  );
}
