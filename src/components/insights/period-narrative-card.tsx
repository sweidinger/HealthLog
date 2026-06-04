"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * v1.11.0 W3 — period-narrative card (Pillar P1).
 *
 * A calm, top-of-overview summary of the user's last week / month, drawn from
 * the read-only `GET /api/insights/narrative` route. The route is
 * stale-while-revalidate: it returns the last good prose instantly and warms a
 * fresh one out of band, so this card never blocks on the provider.
 *
 * Restraint guarantees: plain React text children (NO markdown — the whole
 * tree forbids a markdown library for XSS reasons), no score, no chart, a
 * single ⓘ provenance disclosure, and a fixed `min-h` footprint shared across
 * the loading / preparing / resolved states so the card — and everything below
 * it on the overview — never shifts (no CLS).
 */

type NarrativePeriod = "week" | "month";

interface NarrativeProvenance {
  metrics: string[];
  window: { from: string; to: string };
  pairsTested: number;
  fdrQ: number;
  computedAt: string;
}

interface NarrativeResponse {
  period: NarrativePeriod;
  locale: string;
  narrative: {
    text: string;
    provenance: NarrativeProvenance | null;
    updatedAt: string;
  } | null;
  revalidating: boolean;
}

interface PeriodNarrativeCardProps {
  /** Gate the underlying read (e.g. on the auth flag). */
  enabled?: boolean;
  className?: string;
}

async function fetchNarrative(
  period: NarrativePeriod,
): Promise<NarrativeResponse> {
  const res = await fetch(`/api/insights/narrative?period=${period}`);
  if (!res.ok) {
    throw new Error(`narrative ${res.status}`);
  }
  return (await res.json()).data as NarrativeResponse;
}

function ProvenanceDisclosure({
  provenance,
}: {
  provenance: NarrativeProvenance;
}) {
  const { t } = useTranslations();
  const metrics = provenance.metrics.slice(0, 8).join(", ");
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("insights.narrativeProvenanceLabel")}
        className="text-muted-foreground hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full transition-colors"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" align="end">
        <p className="text-foreground font-medium">
          {t("insights.narrativeProvenanceLabel")}
        </p>
        <p className="text-muted-foreground mt-1">
          {t("insights.narrativeProvenanceMethod")}
        </p>
        {metrics ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("insights.narrativeProvenanceMetrics", { metrics })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const SHELL =
  "bg-card border-border flex min-h-40 w-full min-w-0 flex-col gap-3 rounded-xl border p-4 md:p-6";

export function PeriodNarrativeCard({
  enabled = true,
  className,
}: PeriodNarrativeCardProps) {
  const { t, locale } = useTranslations();
  const [period, setPeriod] = useState<NarrativePeriod>("week");

  const query = useQuery({
    queryKey: queryKeys.insightsNarrative(period, locale),
    queryFn: () => fetchNarrative(period),
    enabled,
    // The route warms out of band; poll briefly while a refresh is in flight
    // so freshly-warmed prose lands without a manual remount.
    refetchInterval: (q) =>
      q.state.data?.revalidating && !q.state.data.narrative ? 5000 : false,
  });

  // Loading with nothing to show yet → matched skeleton (CLS-safe).
  if (query.isLoading) {
    return (
      <div
        data-slot="period-narrative-card-skeleton"
        aria-hidden="true"
        className={cn(SHELL, className)}
      >
        <div className="flex h-7 items-center justify-between gap-2">
          <div className="bg-muted/40 h-3 w-32 rounded" />
          <div className="bg-muted/40 size-5 rounded-full" />
        </div>
        <div className="bg-muted/40 h-4 w-full rounded" />
        <div className="bg-muted/40 h-4 w-5/6 rounded" />
        <div className="bg-muted/40 h-4 w-2/3 rounded" />
      </div>
    );
  }

  // The route never errors the page; on a fetch error or a genuinely empty
  // account (no narrative ever produced) the card un-mounts itself rather than
  // showing an error or an empty husk on the overview.
  if (query.isError || (!query.data?.narrative && !query.data?.revalidating)) {
    return null;
  }

  const data = query.data;
  const narrative = data?.narrative ?? null;
  const preparing = !narrative && data?.revalidating === true;

  return (
    <div
      data-slot="period-narrative-card"
      data-period={period}
      className={cn(SHELL, className)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
          {t("insights.narrativeTitle")}
        </span>
        {narrative?.provenance ? (
          <ProvenanceDisclosure provenance={narrative.provenance} />
        ) : null}
      </div>

      {/* Week / month toggle. Calm segmented control, no chart. */}
      <div className="flex gap-1 self-start">
        {(["week", "month"] as const).map((p) => {
          const active = period === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => setPeriod(p)}
              className={cn(
                "focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p === "week"
                ? t("insights.narrativeWeek")
                : t("insights.narrativeMonth")}
            </button>
          );
        })}
      </div>

      {preparing ? (
        <p className="text-muted-foreground text-sm">
          {t("insights.narrativePreparing")}
        </p>
      ) : (
        // Plain text child — NO markdown renderer (XSS posture, CLAUDE.md).
        <p className="text-foreground text-sm leading-relaxed whitespace-pre-line">
          {narrative?.text}
        </p>
      )}

      {narrative ? (
        <p className="text-muted-foreground mt-auto text-[11px]">
          {data?.revalidating
            ? t("insights.narrativeUpdating")
            : t("insights.narrativeUpdated", {
                time: new Date(narrative.updatedAt).toLocaleDateString(
                  locale === "de" ? "de-DE" : undefined,
                ),
              })}
        </p>
      ) : null}
    </div>
  );
}
