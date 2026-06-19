import * as React from "react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * v1.18.7 — shared list-row primitive.
 *
 * Before this, every list-row "mini-card" (a bordered row sitting inside
 * a section or a `<Card>`) invented its own padding + radius: the
 * Vorsorge dashboard card used `rounded-md p-2.5`, the daily-briefing
 * rows `rounded-md p-3`, the measurement-list mobile row a bespoke
 * `rounded-lg p-3` div. Three surfaces, three shapes for one visual
 * concept. `ListRow` pins the canonical shape — `rounded-lg border p-3`
 * — so the rows read as one language across the app.
 *
 * It owns ONLY the box shape (radius + border + padding). Layout
 * (flex direction, alignment, gap), colour overrides, and interaction
 * state stay with the caller via `className`, so migrating a bespoke row
 * is purely dropping the radius/border/padding literals and keeping the
 * rest.
 *
 * `asChild` renders the row as its single child (e.g. a `<Link>` or
 * `<li>`) while still applying the shared classes, matching the shadcn
 * primitive convention used elsewhere in `ui/`.
 */
function ListRow({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="list-row"
      className={cn("rounded-lg border p-3", className)}
      {...props}
    />
  );
}

export { ListRow };
