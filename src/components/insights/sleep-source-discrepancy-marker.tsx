"use client";

import { TriangleAlert } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "@/lib/i18n/context";
import { formatDurationMinutes } from "@/lib/i18n/duration";

/**
 * v1.28.x — the discreet "sources disagree" marker, extracted from
 * `sleep-hypnogram.tsx` (which introduced it in v1.28.21) so the dashboard
 * sleep tile and the hypnogram render the identical hint off the identical
 * wire shape. Observational only: the headline number always stays the
 * winning writer's total; the tooltip lists each writer's own total so a
 * multi-tracker user can see WHY the night reads surprising.
 */

/** Wire shape of the server-computed annotation (rounded minutes). */
export interface SleepSourceDiscrepancyDto {
  deltaMinutes: number;
  sources: {
    source: string;
    deviceType: string | null;
    asleepMinutes: number;
  }[];
}

/**
 * Localised label keys per `MeasurementSource` — the same map the
 * source-priority settings surface uses (`sources-section.tsx`), so both
 * surfaces humanise a source identically.
 */
const SOURCE_LABEL_KEYS: Record<string, string> = {
  WITHINGS: "settings.sections.sources.sourceLabels.WITHINGS",
  APPLE_HEALTH: "settings.sections.sources.sourceLabels.APPLE_HEALTH",
  MANUAL: "settings.sections.sources.sourceLabels.MANUAL",
  IMPORT: "settings.sections.sources.sourceLabels.IMPORT",
  WHOOP: "settings.sections.sources.sourceLabels.WHOOP",
  COMPUTED: "settings.sections.sources.sourceLabels.COMPUTED",
  FITBIT: "settings.sections.sources.sourceLabels.FITBIT",
};

/**
 * Brand names for sources without a localised settings label — brand
 * spellings are locale-invariant, so no i18n key is needed for them.
 */
const SOURCE_BRAND_NAMES: Record<string, string> = {
  OURA: "Oura",
  POLAR: "Polar",
  GOOGLE_HEALTH: "Google Health",
  NIGHTSCOUT: "Nightscout",
  STRAVA: "Strava",
  TELEGRAM: "Telegram",
  MCP: "MCP",
};

/**
 * Localised device-type label keys (`Measurement.deviceType`), reused from
 * the source-priority settings surface. Appended in parentheses so two
 * writer apps behind the same source (watch vs phone under Apple Health)
 * stay distinguishable in the discrepancy tooltip.
 */
const DEVICE_TYPE_LABEL_KEYS: Record<string, string> = {
  watch: "settings.sections.sources.deviceLabels.watch",
  band: "settings.sections.sources.deviceLabels.band",
  ring: "settings.sections.sources.deviceLabels.ring",
  phone: "settings.sections.sources.deviceLabels.phone",
  scale: "settings.sections.sources.deviceLabels.scale",
  other: "settings.sections.sources.deviceLabels.other",
};

export function sourceDisplayName(
  source: string,
  deviceType: string | null,
  t: (key: string) => string,
): string {
  const labelKey = SOURCE_LABEL_KEYS[source];
  const base = labelKey ? t(labelKey) : (SOURCE_BRAND_NAMES[source] ?? source);
  const deviceKey = deviceType ? DEVICE_TYPE_LABEL_KEYS[deviceType] : undefined;
  return deviceKey ? `${base} (${t(deviceKey)})` : base;
}

export interface SleepSourceDiscrepancyMarkerProps {
  discrepancy: SleepSourceDiscrepancyDto | null | undefined;
  /** Tooltip alignment relative to the trigger (default `"start"`). */
  align?: "start" | "center" | "end";
}

/**
 * Discreet source-discrepancy marker: two writers reported clearly
 * different totals for the night. Muted, no colour wash, no banner;
 * negative margins keep the 44 px hit target from growing the host line
 * (same trick as measurement-diversity-nudge). Renders nothing when the
 * annotation is absent — no layout shift on the ordinary path.
 */
export function SleepSourceDiscrepancyMarker({
  discrepancy,
  align = "start",
}: SleepSourceDiscrepancyMarkerProps) {
  const { t } = useTranslations();
  if (!discrepancy) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="sleep-source-discrepancy"
            aria-label={t("insights.sleep.sourceDiscrepancy.tooltipTitle")}
            className="text-muted-foreground focus-visible:ring-ring/50 -mx-3 -my-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          data-slot="sleep-source-discrepancy-body"
          align={align}
          className="max-w-xs leading-relaxed"
        >
          <p className="font-medium">
            {t("insights.sleep.sourceDiscrepancy.tooltipTitle")}
          </p>
          <p>
            {discrepancy.sources
              .map(
                (b) =>
                  `${sourceDisplayName(b.source, b.deviceType, t)} ${formatDurationMinutes(b.asleepMinutes, t)}`,
              )
              .join(" · ")}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
