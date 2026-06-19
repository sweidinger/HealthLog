import * as React from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `<SettingsCard>` — the standard Settings card container.
 *
 * Every Settings section paints the same bordered surface: a rounded card
 * with the app's one card-padding contract (`p-4 md:p-6` — 16 px on phones,
 * 24 px from `md` up). Before this primitive the surface hand-rolled
 * `bg-card border-border rounded-xl border p-4 sm:p-6` in ~35 files, which
 * (a) bypassed the `<Card>` primitive entirely and (b) stepped padding at
 * `sm:` (640 px) instead of `md:` (768 px), so on a ~700 px tablet Settings
 * cards read denser than every other surface.
 *
 * This wraps the ui `<Card>` so the whole surface composes from one shape.
 * Unlike the bare `<Card>` it does NOT impose the `flex flex-col gap` layout:
 * Settings cards manage their own internal rhythm (`SettingsCardHeader` +
 * `mt-4`/`space-y-*` bodies), so the container only owns the border, radius,
 * background, and padding. Pass `className` for per-card extras
 * (`scroll-mt-28`, `space-y-4`, `flex h-full flex-col`, …).
 */
export function SettingsCard({
  className,
  ...props
}: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        // Reset the primitive's flex/gap layout — Settings card bodies own
        // their internal spacing — and apply the shared `p-4 md:p-6` padding.
        "block gap-0 p-4 md:p-6",
        className,
      )}
      {...props}
    />
  );
}
