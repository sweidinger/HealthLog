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

interface SettingsSectionFrameBaseProps {
  /** Optional content rendered above the heading (e.g. a back-to-hub link). */
  topSlot?: React.ReactNode;
  /** Optional content rendered inline at the top-right of the heading row
   *  (e.g. a guided-tour re-entry trigger). */
  headingAccessory?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Slug mode (the 19 shell sections): title + subtitle come from
 * `settings.sections.<slug>.{title,subtitle}` and the `<h1>` keeps the
 * historic `settings-section-<slug>-title` id for `aria-labelledby` and
 * spotlight-tour anchors.
 */
interface SettingsSectionFrameSlugProps extends SettingsSectionFrameBaseProps {
  slug: SettingsSectionSlug;
}

/**
 * Explicit mode (the per-module settings pages — Vorsorge / Illness / Labs —
 * which deliberately stay out of the slug registry because their static
 * routes win over `/settings/[section]`): caller passes resolved strings and
 * an optional heading id. This lets `ModuleSettingsFrame` delegate here so
 * every settings page shares one heading frame.
 */
interface SettingsSectionFrameExplicitProps extends SettingsSectionFrameBaseProps {
  title: string;
  subtitle: string;
  /** Heading element id (defaults to a stable slug-less id). */
  titleId?: string;
}

export type SettingsSectionFrameProps =
  | SettingsSectionFrameSlugProps
  | SettingsSectionFrameExplicitProps;

function isSlugProps(
  props: SettingsSectionFrameProps,
): props is SettingsSectionFrameSlugProps {
  return "slug" in props;
}

export function SettingsSectionFrame(props: SettingsSectionFrameProps) {
  const { t } = useTranslations();
  const { topSlot, headingAccessory, children } = props;

  let title: string;
  let subtitle: string;
  let titleId: string;
  if (isSlugProps(props)) {
    titleId = `settings-section-${props.slug}-title`;
    title = t(`settings.sections.${props.slug}.title`);
    subtitle = t(`settings.sections.${props.slug}.subtitle`);
  } else {
    titleId = props.titleId ?? "settings-section-title";
    title = props.title;
    subtitle = props.subtitle;
  }

  return (
    <section aria-labelledby={titleId} className="space-y-6">
      {topSlot ? <div>{topSlot}</div> : null}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 id={titleId} className="text-2xl font-bold tracking-tight">
            {title}
          </h1>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </div>
        {headingAccessory ? (
          <div className="shrink-0">{headingAccessory}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
