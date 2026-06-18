"use client";

import type { ReactNode } from "react";

import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";

/**
 * v1.18.6 (W8 / MOD-03) — heading frame for the per-module settings pages
 * (Vorsorge / Illness / Labs).
 *
 * FRAME-ADOPTION SEAM: a parallel phase is introducing a shared
 * `SettingsSectionFrame` primitive under `src/components/settings/*` (which
 * this phase must not edit). Until that lands, this renders the canonical
 * settings heading markup verbatim — `h1.text-2xl.font-bold.tracking-tight`
 * + `p.text-muted-foreground.text-sm` — so the three new pages already
 * conform to the standard and can be swapped to the shared frame at merge by
 * replacing this single wrapper. The back-link reuses the existing
 * `SettingsHubBackLink` (read-only import) so the pages have a consistent
 * "return to the hub" affordance even though they are not listed in the
 * settings-shell sidebar.
 */
export function ModuleSettingsFrame({
  title,
  description,
  backHref,
  backLabelKey,
  children,
}: {
  title: string;
  description: string;
  /** Where the "← back" link returns to — the module's own page. */
  backHref: string;
  backLabelKey: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <SettingsHubBackLink href={backHref} labelKey={backLabelKey} />
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </div>
  );
}
