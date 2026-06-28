"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import {
  useCoachLaunch,
  type CoachLaunchScope,
} from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";

/**
 * v1.21.0 (C4 H2) — discreet "Ask the Coach about this" affordance for
 * high-value insight / assessment cards (briefing, recommendation,
 * correlation, status, health-score, period narrative).
 *
 * It is the reverse-direction entry point the C4 audit flagged as
 * missing: the cards carry the richest context in the app, so a single
 * small action per card opens the Coach pre-scoped to that card's topic
 * with a seeded opener. Reuses the existing launch context — no parallel
 * launch system.
 *
 * Subtle by construction: a ghost, muted-foreground text+icon button (no
 * alarming colour, no card-tinting — the medication-card rule holds). One
 * entry point per card, never a cluster.
 *
 * Self-gates on the same triple the FAB / inline pill use (provider
 * mounted + operator flag + per-user opt-out) so a card never paints a
 * dead Coach control.
 */
export interface AskCoachActionProps {
  /**
   * Composer seed question — a plain-English opener about the card's
   * topic. The Coach treats it as composer seed text, not an i18n key
   * (the chat route is EN/DE-gated), matching the empty-state convention.
   */
  question: string;
  /**
   * Optional scope so the conversation narrows to the card's source(s).
   * Omitted for cards that span the whole picture (e.g. the daily
   * briefing), which read better against the default all-source snapshot.
   */
  scope?: CoachLaunchScope;
  /**
   * Auto-send the seeded question as the conversation's first turn instead
   * of only seeding the composer. The assessment hand-off sets this so the
   * Coach answers immediately; defaults to false (seed-only).
   */
  autoSend?: boolean;
  /** Optional visible-label override; defaults to the shared CTA copy. */
  label?: string;
  /** className passthrough for per-card alignment. */
  className?: string;
}

export function AskCoachAction({
  question,
  scope,
  autoSend,
  label,
  className,
}: AskCoachActionProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();

  // Same gate posture as <CoachLaunchButton> / <LayoutCoachFab>: render
  // nothing unless the provider is mounted, the operator flag is on, and
  // the user has not opted out.
  if (!launch) return null;
  if (!flags.coach) return null;
  if (disableCoach) return null;

  const accessibleLabel = label ?? t("insights.coach.askAboutThis");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="ask-coach-action"
      onClick={() => launch.askCoach(question, scope, autoSend)}
      className={cn(
        // Discreet: muted text, hover lifts to foreground, no fill. Tight
        // height so it sits as a quiet footer link, not a primary CTA.
        "text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2 text-xs",
        className,
      )}
    >
      <Sparkles className="size-3.5" aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </Button>
  );
}
