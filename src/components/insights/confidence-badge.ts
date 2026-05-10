/**
 * v1.4.20 phase D reconcile — shared confidence-band classnames.
 *
 * Both `<CorrelationCard>` and `<TrendAnnotation>` paint a discrete
 * "low / moderate / high" badge with byte-identical Dracula utility
 * classes. Per-component i18n key maps stay local because the copy
 * differs (correlationRow.* vs trendAnnotation.*); only the classname
 * table is the load-bearing duplication.
 */
export type ConfidenceBand = "low" | "moderate" | "high";

export const CONFIDENCE_BADGE_CLASS: Record<ConfidenceBand, string> = {
  high: "border-dracula-green/40 bg-dracula-green/10 text-dracula-green",
  moderate: "border-dracula-orange/40 bg-dracula-orange/10 text-dracula-orange",
  low: "border-dracula-comment/40 bg-dracula-comment/10 text-muted-foreground",
};
