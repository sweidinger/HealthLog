"use client";

import type { ReactNode } from "react";

import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";
import { SettingsSectionFrame } from "@/components/settings/settings-section-frame";

/**
 * v1.18.6 (W8 / MOD-03) — heading frame for the per-module settings pages
 * (Vorsorge / Illness / Labs).
 *
 * Delegates to the shared `SettingsSectionFrame` so every settings page — the
 * 19 shell sections and these three per-module pages — renders one identical
 * heading frame. These pages stay out of the slug registry (their static
 * routes win over `/settings/[section]`), so they drive the frame's explicit
 * title/subtitle mode and supply the "return to the module" back-link through
 * the frame's `topSlot`, which sits above the heading.
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
    <SettingsSectionFrame
      title={title}
      subtitle={description}
      topSlot={<SettingsHubBackLink href={backHref} labelKey={backLabelKey} />}
    >
      {children}
    </SettingsSectionFrame>
  );
}
