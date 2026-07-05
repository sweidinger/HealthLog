import type { ReactNode } from "react";

import { BackLink } from "@/components/ui/back-link";
import { cn } from "@/lib/utils";

/**
 * The one canonical page header. Every module surface renders its title
 * through this so the header vocabulary reads identically app-wide: the H1
 * is always `text-2xl font-bold tracking-tight`, the description is always
 * `text-foreground text-sm` (it is content, not meta — the muted tier is
 * reserved for timestamps/counts per the design standards), and no icon
 * sits beside the H1. An
 * optional back-link rides above the title, and an `actions` slot holds the
 * page's primary buttons to the right of the title block.
 */
export function PageHeader({
  title,
  description,
  backLink,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  backLink?: { href: string; label: string; dataSlot?: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {backLink ? <BackLink {...backLink} /> : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-foreground text-sm">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
