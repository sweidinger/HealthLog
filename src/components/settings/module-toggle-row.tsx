"use client";

/**
 * `<ModuleToggleRow>` — one row in the Settings → Module ("Was du trackst")
 * hub. v1.18.0.
 *
 * Renders a single module: a neutral icon, the i18n label + one-line
 * description, and a `<Switch>` reflecting the resolved enabled-state. The
 * row is presentation-only — the parent `<ModulesSection>` owns the mutation
 * and cache invalidation, so this component stays a pure, easily-tested leaf.
 *
 * Two modes:
 *   - toggleable: the Switch is live; flipping it calls `onToggle(next)`.
 *   - locked (core domains): the Switch is checked + disabled with a short
 *     "always on" note, so the always-on measurement engine + meds read as
 *     deliberately fixed rather than broken. Palette stays neutral — no
 *     alarming green-when-on / red-when-off tint.
 */

import type { LucideIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface ModuleToggleRowProps {
  /** Stable key — used for the input id + the test query handle. */
  moduleKey: string;
  icon: LucideIcon;
  label: string;
  description: string;
  /** Whether the Switch reads on. Core rows pass `true`. */
  enabled: boolean;
  /**
   * When set the row is read-only: the Switch is locked checked and the
   * `lockedNote` line renders beneath the description. Core domains use this.
   */
  locked?: boolean;
  /** One-line "core / always on" note, only shown when `locked`. */
  lockedNote?: string;
  /** Disable the Switch while a mutation is in flight (toggleable rows). */
  pending?: boolean;
  /** Fired with the next desired state on a user toggle (toggleable rows). */
  onToggle?: (next: boolean) => void;
}

export function ModuleToggleRow({
  moduleKey,
  icon: Icon,
  label,
  description,
  enabled,
  locked = false,
  lockedNote,
  pending = false,
  onToggle,
}: ModuleToggleRowProps) {
  const inputId = `module-toggle-${moduleKey}`;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={inputId} className="text-sm font-medium">
            {label}
          </Label>
          <p className="text-muted-foreground text-xs">{description}</p>
          {locked && lockedNote ? (
            <p className="text-muted-foreground/80 text-xs">{lockedNote}</p>
          ) : null}
        </div>
      </div>
      <Switch
        id={inputId}
        checked={locked ? true : enabled}
        disabled={locked || pending}
        onCheckedChange={locked ? undefined : (v) => onToggle?.(v)}
        className="mt-0.5 shrink-0"
        aria-label={label}
      />
    </div>
  );
}
