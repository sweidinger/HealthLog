"use client";

import { CheckCircle2, AlertTriangle, Activity } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { ProvenanceExplainer } from "@/components/insights/derived/provenance-explainer";
import { METRIC_PROVENANCE } from "@/components/insights/derived/standards";
import { useDerivedMetric } from "@/components/insights/derived/use-derived-metric";
// Type-only — the compute payload never drags the server graph into the bundle
// (the v1.9.0 lesson, mirrored at vitals-dashboard.tsx).
import type { CoincidentDeviationValue } from "@/lib/insights/derived/coincident-deviation";
import type { DerivedProvenance } from "@/lib/insights/derived/types";

/**
 * v1.10.3 — "Today's signal" headline card.
 *
 * Promotes the COINCIDENT_DEVIATION flag from one buried below-the-fold vitals
 * tile (painted only when it fired) to a dedicated, always-mounted card at the
 * top of the Insights overview, matching the always-present pattern Apple
 * Vitals / WHOOP Health Monitor / Oura Symptom Radar use. The signal is the
 * daily headline read, not an alarm: an "all clear" day is itself the
 * reassuring product.
 *
 * It renders four calm states off the SINGLE existing `Derived` payload — no
 * new engine math, no new route, no schema change:
 *   - insufficient (< 2 banded vitals) → "building your baselines" + coverage.
 *   - all-clear (ok, !fired, 0 contributing) → a green check + the count
 *     checked.
 *   - watch (ok, !fired, 1 contributing) → a calm, non-alert line naming the
 *     one vital.
 *   - fired (ok, fired, ≥ 2 contributing) → an amber awareness card naming the
 *     vitals + the load-bearing "possible factors — never a cause" line.
 *
 * Restraint guarantees: at most the `warning` (amber) band — never
 * `destructive`/red, never a score, never a chart (so no Recharts), never a
 * push. When `confidence.band` is thin (low/draft) the fired tone is softened
 * to the watch tone + the coverage meter, so a multi-signal flag from too
 * little history never reads as a confident verdict.
 */

const COINCIDENT_METRIC = "COINCIDENT_DEVIATION";

interface CoincidentDeviationCardProps {
  /** Gate the underlying derived-metric read (e.g. on the auth flag). */
  enabled?: boolean;
  className?: string;
}

/** The four calm visual states, derived from the single payload. */
type SignalState = "insufficient" | "all-clear" | "watch" | "fired";

/** The provenance ⓘ explainer for the coincident flag, wired from the map. */
function CoincidentProvenance({
  provenance,
}: {
  provenance: DerivedProvenance;
}) {
  const { t } = useTranslations();
  const meta = METRIC_PROVENANCE.COINCIDENT_DEVIATION;
  const method = (
    <>
      {meta.caveatKey ? (
        <span className="text-warning block font-medium">
          {t(meta.caveatKey)}
        </span>
      ) : null}
      {t(meta.methodKey)}
    </>
  );
  return (
    <ProvenanceExplainer
      provenance={provenance}
      method={method}
      standard={meta.standard}
    />
  );
}

/**
 * The card shell — uppercase label + the provenance affordance, with the
 * state-specific body as children. Keeps every state on one card geometry so
 * the page reserves a stable footprint.
 */
function CardShell({
  state,
  provenance,
  children,
}: {
  state: SignalState;
  provenance?: DerivedProvenance;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="coincident-deviation-card"
      data-state={state}
      className={cn(
        "bg-card flex w-full min-w-0 flex-col gap-2 rounded-xl border p-4 md:p-6",
        // At most amber — never destructive/red. The fired state borders
        // warning; every calmer state keeps the neutral card border.
        state === "fired" ? "border-warning/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
          {t("insights.derived.coincident.cardTitle")}
        </span>
        {provenance ? <CoincidentProvenance provenance={provenance} /> : null}
      </div>
      {children}
    </div>
  );
}

/** A fixed-footprint skeleton matching the resolved card (CLS-safe). */
function CardSkeleton() {
  return (
    <div
      data-slot="coincident-deviation-card-skeleton"
      aria-hidden="true"
      className="bg-card border-border flex w-full min-w-0 flex-col gap-3 rounded-xl border p-4 md:p-6"
    >
      <div className="bg-muted/40 h-3 w-28 rounded" />
      <div className="bg-muted/40 h-5 w-3/4 rounded" />
      <div className="bg-muted/40 h-3 w-1/2 rounded" />
    </div>
  );
}

export function CoincidentDeviationCard({
  enabled = true,
  className,
}: CoincidentDeviationCardProps) {
  const { t } = useTranslations();
  const { data } = useDerivedMetric<CoincidentDeviationValue>(
    COINCIDENT_METRIC,
    { enabled },
  );

  // CLS-safe placeholder while the single read is in flight.
  if (!data) {
    return (
      <div className={className}>
        <CardSkeleton />
      </div>
    );
  }

  // Building the baselines — fewer than two banded vitals. Calm, never an
  // alarm, never blank.
  if (data.status === "insufficient") {
    return (
      <div className={className}>
        <CardShell state="insufficient" provenance={data.provenance}>
          <p
            className="text-muted-foreground text-sm"
            data-slot="coincident-building"
          >
            {t("insights.derived.coincident.building")}
          </p>
          <CoverageMeter coverage={data.coverage} />
        </CardShell>
      </div>
    );
  }

  const v = data.value!;
  const contributing = v.contributing;
  const names = contributing
    .map((d) => {
      const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[d.type];
      return labelKey ? t(labelKey) : d.type;
    })
    .join(", ");

  // Thin history behind the deepest contributing vital → soften a fired flag
  // to the watch tone rather than presenting a confident multi-signal verdict
  // from too little data. Read straight off the existing payload.
  const band = data.confidence?.band;
  const thinHistory = band === "low" || band === "draft";

  // Map the single payload onto one of the four calm states.
  const state: SignalState =
    contributing.length === 0
      ? "all-clear"
      : v.fired && contributing.length >= 2 && !thinHistory
        ? "fired"
        : "watch";

  if (state === "all-clear") {
    return (
      <div className={className}>
        <CardShell state="all-clear" provenance={data.provenance}>
          <div className="flex items-start gap-2">
            <CheckCircle2
              className="text-success mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p
                className="text-foreground text-sm font-medium"
                data-slot="coincident-headline"
              >
                {t("insights.derived.coincident.allClear")}
              </p>
              <p className="text-muted-foreground text-xs leading-snug">
                {t("insights.derived.coincident.allClearMeta", {
                  count: v.vitals.length,
                })}
              </p>
            </div>
          </div>
        </CardShell>
      </div>
    );
  }

  if (state === "watch") {
    return (
      <div className={className}>
        <CardShell state="watch" provenance={data.provenance}>
          <div className="flex items-start gap-2">
            <Activity
              className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p
                className="text-foreground text-sm font-medium"
                data-slot="coincident-headline"
              >
                {t("insights.derived.coincident.watch")}
              </p>
              <p className="text-muted-foreground text-xs leading-snug">
                {t("insights.derived.coincident.watchVital", { vital: names })}
              </p>
            </div>
          </div>
          {thinHistory ? <CoverageMeter coverage={data.coverage} /> : null}
        </CardShell>
      </div>
    );
  }

  // fired — amber awareness, named vitals, possible-factors line (mandatory).
  return (
    <div className={className}>
      <CardShell state="fired" provenance={data.provenance}>
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="text-warning mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p
              className="text-foreground text-sm font-medium"
              data-slot="coincident-headline"
            >
              {t("insights.derived.coincident.firedHeadline", {
                count: contributing.length,
              })}
            </p>
            <p
              className="text-muted-foreground text-xs leading-snug"
              data-slot="coincident-vitals"
            >
              {t("insights.derived.coincident.vitals", { list: names })}
            </p>
          </div>
        </div>
        <p
          className="text-muted-foreground text-xs leading-snug"
          data-slot="coincident-factors"
        >
          {t("insights.derived.coincident.factors")}
        </p>
      </CardShell>
    </div>
  );
}
