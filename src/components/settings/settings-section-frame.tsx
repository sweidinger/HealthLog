"use client";

/**
 * `<SettingsSectionFrame>` — the canonical page-frame for every Settings
 * section. The settings twin of the admin renderer's `SectionFrame`
 * (`src/app/admin/[section]/renderer.tsx`): it emits the one visible
 * heading + subheading every page must show, in the reference style used by
 * the Admin Konsole → Übersicht landing.
 *
 * Before this primitive every settings section hand-rolled its own
 * `sr-only` `<h1>`, so no settings page showed a visible heading and the
 * left-menu-to-first-card alignment drifted page to page. Routing all 19
 * sections through one frame fixes both: a constant-height heading block
 * above the first card, and a real visible `h1 + subtitle`.
 *
 *   <SettingsSectionFrame slug="account">
 *     {cards}
 *   </SettingsSectionFrame>
 *
 * Title comes from `settings.sections.<slug>.title`; subtitle from
 * `settings.sections.<slug>.subtitle`. The `<h1>` keeps the historic
 * `settings-section-<slug>-title` id so the section's own `aria-labelledby`
 * linkage — and the spotlight-tour anchors that reference it — stay intact.
 *
 * `topSlot` renders ABOVE the heading (used by the Layout-hub child
 * editors for their "← back to hub" link, which must sit above the title).
 * `headingAccessory` renders inline at the top-right of the heading row
 * (used by Gesundheitsakte for its guided-tour re-entry trigger).
 */

import * as React from "react";

import { useTranslations } from "@/lib/i18n/context";
import type { SettingsSectionSlug } from "./section-slugs";

export interface SettingsSectionFrameProps {
  slug: SettingsSectionSlug;
  /** Optional content rendered above the heading (e.g. a back-to-hub link). */
  topSlot?: React.ReactNode;
  /** Optional content rendered inline at the top-right of the heading row
   *  (e.g. a guided-tour re-entry trigger). */
  headingAccessory?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsSectionFrame({
  slug,
  topSlot,
  headingAccessory,
  children,
}: SettingsSectionFrameProps) {
  const { t } = useTranslations();
  const titleId = `settings-section-${slug}-title`;

  return (
    <section aria-labelledby={titleId} className="space-y-6">
      {topSlot ? <div>{topSlot}</div> : null}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 id={titleId} className="text-2xl font-bold tracking-tight">
            {t(`settings.sections.${slug}.title`)}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t(`settings.sections.${slug}.subtitle`)}
          </p>
        </div>
        {headingAccessory ? (
          <div className="shrink-0">{headingAccessory}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
