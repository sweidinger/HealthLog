"use client";

/**
 * P1 — `PriorityCard`, the ONE card behind every "worth a look" rail item.
 *
 * It renders a `PriorityItem` and never fetches. Every later consumer reuses
 * it verbatim: the Today rail (S2), a coach check-in (S3), a milestone
 * celebration (S12), a new-ECG pointer (S10), a tension window (S11). A new
 * rail type is a new `kind` on the item + a server builder — never a new
 * component (§1.2 P1).
 *
 * Design: composed ENTIRELY from shipped primitives — `Card` (compact
 * density) + `TileHeader` (size `sm`, foreground icon) + `ProseBlocks` for the
 * grounded one-liner, semantic-token status wash only, no raw palette colour
 * (the `no-raw-palette-color` rule errors), no markdown. The Lucide glyph is
 * derived from `kind` so the wire DTO stays serialisable (the icon lives with
 * the renderer, the closed enum with the model). The `animate-insight-in`
 * reveal carries its own reduced-motion fallback in `globals.css`.
 */
import Link from "next/link";
import {
  Activity,
  Award,
  CalendarClock,
  HeartPulse,
  MessageCircle,
  Pill,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type {
  PriorityItem,
  PriorityItemAction,
  PriorityItemKind,
  PriorityItemStatus,
} from "@/lib/daily/priority-item";

/** Deterministic glyph per kind — the icon the serialisable item cannot hold. */
const KIND_ICON: Record<PriorityItemKind, LucideIcon> = {
  dose_window: Pill,
  preventive_care: CalendarClock,
  sync_issue: RefreshCw,
  coach_checkin: MessageCircle,
  milestone: Award,
  ecg_new_recording: HeartPulse,
  tension_window: Activity,
};

/**
 * Status wash — a subtle semantic-token tint carrying MEANING, not decoration
 * (the `recommendation-card` pattern). Static classes so Tailwind sees them.
 */
const STATUS_WASH: Record<PriorityItemStatus, string> = {
  success: "bg-success/10 border-success/25",
  warning: "bg-warning/10 border-warning/25",
  info: "bg-info/10 border-info/25",
  destructive: "bg-destructive/10 border-destructive/25",
};

export interface PriorityCardProps {
  item: PriorityItem;
  /**
   * Tap handler for non-navigation actions. Receives the action's stable
   * `intent` token. Navigation actions (those carrying an `href`) render as
   * links and do not call this.
   */
  onAction?: (intent: string) => void;
  className?: string;
}

/** Tap-target floor per P1: `min-h-11` on touch, `min-h-9` on pointer. */
const ACTION_SIZE = "min-h-11 sm:min-h-9";

export function PriorityCard({ item, onAction, className }: PriorityCardProps) {
  const { t } = useTranslations();
  const Icon = KIND_ICON[item.kind];
  const actions = item.actions.slice(0, 3);

  return (
    <Card
      data-slot="priority-card"
      data-kind={item.kind}
      className={cn(
        "animate-insight-in gap-2 py-3 md:gap-2 md:py-4",
        item.status ? STATUS_WASH[item.status] : null,
        className,
      )}
    >
      <CardContent className="flex flex-col gap-2">
        <TileHeader icon={Icon} title={item.title} size="sm" />
        {item.body ? (
          <div className="text-foreground text-sm">
            <ProseBlocks text={item.body} strip={false} linkify={false} />
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {actions.map((action) => (
              <ActionButton
                key={action.intent}
                action={action}
                label={t(action.labelKey)}
                onAction={onAction}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ActionButton({
  action,
  label,
  onAction,
}: {
  action: PriorityItemAction;
  label: string;
  onAction?: (intent: string) => void;
}) {
  if (action.href) {
    return (
      <Link
        href={action.href}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          ACTION_SIZE,
        )}
      >
        {label}
      </Link>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className={ACTION_SIZE}
      onClick={() => onAction?.(action.intent)}
    >
      {label}
    </Button>
  );
}
