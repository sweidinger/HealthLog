"use client";

import { cn } from "@/lib/utils";
import type { DerivedProvenance } from "@/lib/insights/derived/types";

/**
 * v1.10.0 — the "how this is computed" surface.
 *
 * v1.22 — the collapsible `ⓘ` glyph that gated the method/inputs/window read
 * behind a popover / bottom-sheet is removed; the maintainer wants the
 * trailing info affordance gone across the insights surface. The
 * plain-language method now renders inline as a muted caption (React text
 * children only — the XSS rule still forbids a markdown library), so the
 * "how computed" line is always visible rather than disclosure-only. The
 * `provenance`, `standard` and `title` props are retained for callers; the
 * inputs-chip / window / cited-standard detail folded out with the popover.
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
  /** Optional cited standard. Retained for callers. */
  standard?: ProvenanceStandard;
  /** Accessible title of the surface. Retained for callers. */
  title?: string;
  /** Optional className for the caption. */
  className?: string;
  /** Optional id the parent threads as aria-describedby on its own element. */
  bodyId?: string;
}

export function ProvenanceExplainer({
  method,
  className,
  bodyId,
}: ProvenanceExplainerProps) {
  return (
    <span
      id={bodyId}
      data-slot="provenance-explainer-method"
      className={cn("text-muted-foreground text-xs leading-snug", className)}
    >
      {method}
    </span>
  );
}
