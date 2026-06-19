"use client";

import { useId, useState } from "react";
import { ExternalLink, Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { DerivedProvenance } from "@/lib/insights/derived/types";

/**
 * v1.10.0 — the "how this is computed / standard cited" surface.
 *
 * A collapsible `ⓘ` explainer that renders, as React text children (NO
 * markdown library — the XSS rule), the metric's inputs, a plain-language
 * method, and an optional link to the cited standard (IEEE / RFC / WHO /
 * LOINC / Wikipedia). Reads the `provenance` field off `Derived<T>` for the
 * inputs chip + the "as of" + window framing.
 *
 * Surface follows the shipped `health-score-delta-explainer` pattern:
 * Popover on `md+`, bottom-sheet on phone-class viewports via
 * `ResponsiveSheet`. Owns its own open state. aria-describedby threads the
 * trigger to the body.
 */

export interface ProvenanceStandard {
  /** Display name of the cited standard (e.g. "WHO BMI classification"). */
  name: string;
  /** Absolute URL to the standard. Rendered as a plain `<a>`, never HTML. */
  url: string;
}

export interface ProvenanceExplainerProps {
  /** The provenance facet off `Derived<T>` — inputs, source, window, asOf. */
  provenance: DerivedProvenance;
  /**
   * Plain-language method description. Text children only — the caller
   * passes a localised string; the component never parses markup.
   */
  method: React.ReactNode;
  /** Optional cited standard rendered as an external link in the footer. */
  standard?: ProvenanceStandard;
  /** Accessible title of the surface (sheet header / popover first line). */
  title?: string;
  /** Optional className for the trigger button. */
  className?: string;
  /** Optional id the parent threads as aria-describedby on its own element. */
  bodyId?: string;
}

export function ProvenanceExplainer({
  provenance,
  method,
  standard,
  title,
  className,
  bodyId,
}: ProvenanceExplainerProps) {
  const { t, locale } = useTranslations();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const resolvedBodyId = bodyId ?? generatedId;

  const resolvedTitle = title ?? t("insights.derived.provenance.title");
  const triggerLabel = t("insights.derived.provenance.trigger");

  const asOf = (() => {
    const parsed = new Date(provenance.computedAt);
    if (Number.isNaN(parsed.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      }).format(parsed);
    } catch {
      return null;
    }
  })();

  const body = (
    <div
      id={resolvedBodyId}
      data-slot="provenance-explainer-body"
      className="space-y-3"
    >
      <div data-slot="provenance-explainer-inputs">
        <p className="text-foreground text-xs font-semibold">
          {t("insights.derived.provenance.inputsLabel")}
        </p>
        {provenance.inputs.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {provenance.inputs.map((input) => (
              <li
                key={input}
                data-slot="provenance-explainer-input-chip"
                className="border-info/40 text-info inline-flex items-center rounded-full border bg-transparent px-1.5 py-0.5 text-[10px] leading-none"
              >
                {input}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t("insights.derived.provenance.noInputs")}
          </p>
        )}
      </div>

      <div data-slot="provenance-explainer-method">
        <p className="text-foreground text-xs font-semibold">
          {t("insights.derived.provenance.methodLabel")}
        </p>
        <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
          {method}
        </p>
      </div>

      <p
        data-slot="provenance-explainer-window"
        className="text-muted-foreground text-[11px] leading-snug"
      >
        {t("insights.derived.provenance.window", {
          days: provenance.windowDays,
          source: provenance.source,
        })}
        {asOf
          ? ` · ${t("insights.derived.provenance.asOf", { date: asOf })}`
          : ""}
      </p>

      {standard && (
        <a
          data-slot="provenance-explainer-standard-link"
          href={standard.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-info hover:text-info/80 focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded text-[11px] font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          {t("insights.derived.provenance.standardLink", {
            name: standard.name,
          })}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );

  const trigger = (
    <button
      type="button"
      data-slot="provenance-explainer-trigger"
      aria-label={triggerLabel}
      aria-expanded={open}
      aria-controls={resolvedBodyId}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
        "-mx-2 -my-3",
        "transition-colors focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
      onClick={() => setOpen(true)}
    >
      <Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title={resolvedTitle}
        >
          <div className="text-sm">{body}</div>
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-slot="provenance-explainer-popover"
        align="start"
        sideOffset={6}
        className="max-w-xs space-y-2"
      >
        <p
          data-slot="provenance-explainer-title"
          className="text-foreground text-xs font-semibold"
        >
          {resolvedTitle}
        </p>
        {body}
      </PopoverContent>
    </Popover>
  );
}
