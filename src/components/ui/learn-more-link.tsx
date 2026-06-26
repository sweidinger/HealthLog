"use client";

import { ExternalLink } from "lucide-react";

import { learnLinkForMetric } from "@/lib/learn-links";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.21.0 — discreet "Learn more" pointer to a public /learn guide.
 *
 * One small, calm anchor (no new colour, no card chrome) that links a concept
 * out to its plain-language guide. Fail-closed by construction:
 *
 *   - the href is resolved through `learnLinkForMetric` — a closed-set,
 *     registry-backed URL, never user/model content — so there is no XSS
 *     surface and no invented link;
 *   - an unmapped concept resolves to `null` and the component renders
 *     nothing, so a surface that wires a concept with no guide simply shows
 *     no pointer rather than a broken one.
 *
 * It is a literal `<a>` (no markdown library): `target="_blank"` with
 * `rel="noopener noreferrer"`, the guide title as the accessible label.
 */
export interface LearnMoreLinkProps {
  /**
   * A `LearnConcept` key (or any metric id) to resolve. Anything unmapped
   * renders nothing.
   */
  concept: string;
  className?: string;
}

export function LearnMoreLink({ concept, className }: LearnMoreLinkProps) {
  const { t } = useTranslations();
  const guide = learnLinkForMetric(concept);
  if (guide == null) return null;

  const label = t("common.learnMore");

  return (
    <a
      href={guide.url}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="learn-more-link"
      aria-label={`${label}: ${guide.title}`}
      className={cn(
        "text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 transition-colors hover:underline",
        className,
      )}
    >
      {label}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}
