"use client";

/**
 * v1.7.0 — advanced-settings group header.
 * v1.8.6 — rebuilt as a bordered section card. The sheet now stacks
 * every group in a single column (Reminders → Lifecycle → Data →
 * Danger), so each group needs its own frame to read as a distinct
 * block rather than a hairline-separated run. The card owns one spacing
 * rule: an uppercase micro-label header, then a `divide-y` body where
 * each row carries `py-3`. Callers pass one `<div>` per row; the card
 * supplies the dividers so no row interleaves its own `<Separator>`.
 *
 * The label is a plain `<p>` (not a heading with an id) so it stays out
 * of the `aria-labelledby` graph — the sheet already owns the dialog
 * title, and the inner switch labels carry their own ids. This avoids
 * the duplicate-id axe failure the section-card heading split guards
 * against.
 */

import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SettingsGroupProps {
  label: ReactNode;
  children: ReactNode;
  dataSlot?: string;
  className?: string;
}

export function SettingsGroup({
  label,
  children,
  dataSlot,
  className,
}: SettingsGroupProps) {
  return (
    <section
      className={cn("bg-card rounded-lg border px-4 py-1", className)}
      {...(dataSlot ? { "data-slot": dataSlot } : {})}
    >
      <p className="text-muted-foreground border-border/60 border-b py-2.5 text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      <div className="divide-border/60 divide-y">{children}</div>
    </section>
  );
}
