"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * v1.4.27 MB7 / CF-52 — shared `<select>` primitive.
 *
 * Three settings/admin surfaces (`AccountSection`, `TimezonePicker`,
 * `GeneralSettingsSection`) each declared a local `NATIVE_SELECT_CLASS`
 * constant that traced the same visual contract as the shadcn
 * `<SelectTrigger>` (border + bg + ring tokens, focus vocabulary).
 * The three copies had drifted slightly — one dropped `w-full`,
 * another dropped the `shadow-xs` token — so the three forms rendered
 * at subtly different weights despite reading "the same select" to
 * the user.
 *
 * The primitive collapses the duplicates. Consumers wrap it like a
 * raw `<select>` and the className still composes via `cn(...)` so
 * site-specific tweaks (`sm:max-w-sm`, etc.) keep working.
 *
 * Height: `h-10` (40 px) — matches the v1.4.27 tap-target floor on
 * `<Input>` and `<SelectTrigger>` (MB2). The legacy `h-9` (36 px)
 * the three call sites carried was the pre-v1.4.27 contract; the
 * primitive extraction lands at the new floor so every form input on
 * the same row reads at the same height.
 *
 * Why native? The shadcn `<Select>` from `@radix-ui/react-select` is
 * the better keyboard experience on desktop but pulls in extra
 * client JS and does not show the iOS / Android native picker.
 * Settings/admin surfaces benefit from the native picker (especially
 * for the 400-entry timezone list) so we deliberately stay on
 * `<select>` here. The styled primitive keeps the visual rhythm
 * uniform with the rest of the form's `<Input>` + `<SelectTrigger>`
 * rows.
 */
// v1.4.34 IW-G — floor at 44 px on mobile to clear WCAG 2.5.5; shrink
// to 40 px on sm+ where the pointer precision is higher.
//
// Chevron symmetry: `appearance-none` drops the browser-drawn dropdown arrow,
// whose right inset is OS-controlled and reads visibly farther from the edge
// than the value text sits from the left. We paint our own chevron as a
// background SVG positioned `right 0.75rem center` (12 px) so its inset mirrors
// the left text padding (`px-3`) — matching the shadcn `<SelectTrigger>`.
// Doing it as a background (rather than an overlay element) keeps `<select>` a
// single element, so every call site's width / margin className still composes
// straight onto it. `pe-9` reserves room so a long value never runs under the
// chevron. The chevron glyph is the same path Lucide's `ChevronDownIcon` draws,
// at `currentColor` with 50 % opacity to match the trigger.
const CHEVRON_SVG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' opacity='0.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

const NATIVE_SELECT_CLASS =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-11 sm:h-10 w-full appearance-none rounded-md border ps-3 pe-9 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none bg-[image:var(--native-select-chevron)] bg-[length:1rem] bg-[position:right_0.75rem_center] bg-no-repeat";

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  NativeSelectProps
>(function NativeSelect({ className, children, style, ...props }, ref) {
  return (
    <select
      ref={ref}
      data-slot="native-select"
      className={cn(NATIVE_SELECT_CLASS, className)}
      style={
        {
          "--native-select-chevron": CHEVRON_SVG,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </select>
  );
});
