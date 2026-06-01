"use client";

import { Target } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.6 — in-target headline tile.
 *
 * Promotes the already-computed `inTargetPct` (previously only fed to
 * the LLM snapshot) to a visible stat: the share of recent days that
 * landed in the good-mood band. Renders nothing when the number is
 * unavailable (no recent data) so the page degrades gracefully.
 */
export function MoodInTargetTile({ pct }: { pct: number | null }) {
  const { t } = useTranslations();

  if (pct == null) return null;

  const rounded = Math.round(pct);

  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
          <Target className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-foreground text-2xl font-semibold tabular-nums">
            {t("insights.mood.inTargetValue", { pct: String(rounded) })}
          </p>
          <p className="text-muted-foreground text-sm">
            {t("insights.mood.inTargetCaption")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
