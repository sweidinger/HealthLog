import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * v1.16.16 — shared back-navigation control.
 *
 * The detail / sub-page surfaces (`/insights/workouts/[id]`,
 * `/insights/values/[type]`, `/insights/scores/[metric]`,
 * `/medications/[id]`) each hand-rolled the identical
 * `Button(ghost, sm, -ml-2 w-fit) > Link > ArrowLeft + label` block. This
 * folds that into one component so the back-nav reads the same — same hit
 * area, same icon, same left-bleed alignment — on every page, and a future
 * change to the affordance lives in one place.
 *
 * The label travels in from the caller (each page already owns its own
 * translation key, e.g. `insights.workouts.detail.backToList`), so this
 * component adds no new i18n surface.
 */
export interface BackLinkProps {
  /** Internal href the back-nav points at. */
  href: string;
  /** Already-translated label text. */
  label: string;
  /** Optional per-surface `data-slot` for e2e/visual targeting. */
  dataSlot?: string;
  className?: string;
}

export function BackLink({ href, label, dataSlot, className }: BackLinkProps) {
  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      data-slot={dataSlot}
      className={cn("-ml-2 w-fit", className)}
    >
      <Link href={href}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}
