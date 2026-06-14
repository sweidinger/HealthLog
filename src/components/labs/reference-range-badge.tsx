"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import type { ReferenceRangeStatus } from "@/lib/validations/labs";

/**
 * v1.17.1 — reference-range badge.
 *
 * Renders the server-computed `rangeStatus` as a calm, informative marker.
 * The project's no-alarming-colour ethos is a hard rule here: an
 * out-of-range value is NOT painted red. It reads as a neutral `secondary`
 * badge with a quiet direction arrow (↓ below / ↑ above), exactly the same
 * weight as the in-range and unknown states. The number leaving the
 * reference window is information a clinician scans — not an alarm to the
 * user, who may be perfectly aware of (and managing) the value.
 *
 * `unknown` (the lab reported no usable bounds) renders nothing — there is
 * no verdict to show, and an empty badge would be noise.
 */
export function ReferenceRangeBadge({
  status,
}: {
  status: ReferenceRangeStatus;
}) {
  const { t } = useTranslations();

  if (status === "unknown") return null;

  if (status === "in-range") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Minus aria-hidden />
        {t("labs.range.inRange")}
      </Badge>
    );
  }

  // Below / above — both neutral `secondary`, distinguished only by the
  // arrow direction and label. No red, no amber.
  const Icon = status === "below" ? ArrowDown : ArrowUp;
  const label =
    status === "below" ? t("labs.range.below") : t("labs.range.above");
  return (
    <Badge variant="secondary">
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
