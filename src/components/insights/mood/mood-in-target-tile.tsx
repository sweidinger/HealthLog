"use client";

import { Target } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.6 — in-target headline tile.
 *
 * Promotes the already-computed `inTargetPct` (previously only fed to
 * the LLM snapshot) to a visible stat: the share of recent days that
 * landed in the good-mood band. Renders nothing when the number is
 * unavailable (no recent data) so the page degrades gracefully.
 *
 * v1.12.6 — the tile now leads with the canonical `TileHeader`
 * (icon + white heading) so it speaks the same card language as every
 * other Insights tile; the icon-in-a-circle headline glyph is dropped.
 */
export function MoodInTargetTile({ pct }: { pct: number | null }) {
  const { t } = useTranslations();

  if (pct == null) return null;

  const rounded = Math.round(pct);

  return (
    <Card>
      <CardHeader className="pb-2">
        <TileHeader icon={Target} title={t("insights.mood.inTargetTitle")} />
      </CardHeader>
      <CardContent>
        <p className="text-foreground text-2xl font-semibold tabular-nums">
          {t("insights.mood.inTargetValue", { pct: String(rounded) })}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("insights.mood.inTargetCaption")}
        </p>
      </CardContent>
    </Card>
  );
}
