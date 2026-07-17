import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shimmering placeholder used while data is loading. Wrap text-equivalent
 * shapes so the page does not jump when real content arrives.
 *
 * v1.29.0 — the whole-block `animate-pulse` throb is upgraded to a single
 * soft `skeleton-shimmer` sweep (a `--foreground`-mix gradient gliding
 * across the muted base, defined in `globals.css`), so every loading
 * surface shares one calm loading language. Honours
 * `prefers-reduced-motion` via the shimmer's own CSS guard, which
 * collapses it to the static muted block.
 *
 * Pattern: render the same layout the loaded UI will render, with each
 * dynamic block replaced by a `<Skeleton className="h-X w-Y" />`.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      role="presentation"
      aria-hidden="true"
      className={cn("bg-muted/60 skeleton-shimmer rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
