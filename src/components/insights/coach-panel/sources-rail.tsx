"use client";

import {
  Activity,
  Eye,
  Heart,
  HeartPulse,
  Pill,
  Scale,
  Smile,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B2b — "What I can see" rail.
 *
 * Right-column companion in the Coach drawer. Lists the data sources
 * the assistant draws on so the user can build trust in the
 * provenance. v1.4.20 ships with a hard-coded list keyed off the
 * five contracts the snapshot helper currently surfaces (BP, weight,
 * pulse, mood, medication compliance). v1.4.21 will plug in fresh /
 * stale dot indicators by reusing `<IntegrationStatusPill>`.
 *
 * Hardcoding the list here is deliberate: every line is i18n-driven
 * so locale switching works out of the box, and the underlying user
 * data is already gated behind the page-level `requireAuth()` so a
 * user without a connected source still sees the legend.
 */
export interface SourcesRailProps {
  className?: string;
}

interface SourceRow {
  key: string;
  metricKey: string;
  Icon: React.ComponentType<{ className?: string }>;
  accentClass: string;
}

const ROWS: SourceRow[] = [
  {
    key: "bp",
    metricKey: "insights.coach.metric.bp",
    Icon: HeartPulse,
    accentClass: "text-dracula-purple",
  },
  {
    key: "weight",
    metricKey: "insights.coach.metric.weight",
    Icon: Scale,
    accentClass: "text-dracula-cyan",
  },
  {
    key: "pulse",
    metricKey: "insights.coach.metric.pulse",
    Icon: Heart,
    accentClass: "text-dracula-pink",
  },
  {
    key: "mood",
    metricKey: "insights.coach.metric.mood",
    Icon: Smile,
    accentClass: "text-dracula-green",
  },
  {
    key: "compliance",
    metricKey: "insights.coach.metric.compliance",
    Icon: Pill,
    accentClass: "text-dracula-orange",
  },
];

export function SourcesRail({ className }: SourcesRailProps) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="coach-sources-rail"
      className={cn("flex h-full min-h-0 flex-col gap-3 p-3", className)}
    >
      <div className="flex items-center gap-1.5 px-1">
        <Eye className="text-muted-foreground size-3.5" aria-hidden="true" />
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {t("insights.coach.sourcesTitle")}
        </span>
      </div>
      <ul
        data-slot="coach-sources-list"
        className="flex flex-1 flex-col gap-1.5"
      >
        {ROWS.map((row) => (
          <li
            key={row.key}
            data-slot="coach-sources-row"
            data-source={row.key}
            className={cn(
              "border-border/60 bg-muted/30 flex items-center gap-2",
              "rounded-md border px-2.5 py-2",
            )}
          >
            <row.Icon
              className={cn("size-3.5", row.accentClass)}
              aria-hidden="true"
            />
            <span className="text-foreground flex-1 text-xs font-medium">
              {t(row.metricKey)}
            </span>
            {/* Fresh / stale indicator — v1.4.20 is a static dot
                with no real freshness state behind it (v1.4.21 plugs
                in <IntegrationStatusPill>). aria-hidden so SR users
                don't hear "Fresh" five times in a row for what is
                actually a placeholder. */}
            <span
              aria-hidden="true"
              className="bg-dracula-green size-1.5 rounded-full"
            />
          </li>
        ))}
      </ul>
      <div className="border-border/50 mt-auto flex items-start gap-2 border-t pt-3">
        <Activity
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
        />
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {t("insights.coach.sourcesFooter")}
        </p>
      </div>
    </div>
  );
}
