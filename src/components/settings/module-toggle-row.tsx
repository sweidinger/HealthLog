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
 * Four modes:
 *   - toggleable: the Switch is live; flipping it calls `onToggle(next)`.
 *   - locked (core domains): the Switch is checked + disabled with a short
 *     "always on" note, so the always-on measurement engine + meds read as
 *     deliberately fixed rather than broken.
 *   - managed elsewhere (delegated modules cycle/coach): no Switch at all —
 *     the real on/off lives in another section, so the row renders a
 *     read-only deep-link ("Manage in X") rather than a dead toggle that
 *     no-ops and snaps back behind a misleading "saved" toast.
 *   - operator-disabled: the operator turned the module off server-wide, so
 *     the Switch is replaced by a read-only "disabled server-wide" note —
 *     a per-user toggle could not re-enable it anyway.
 *
 * Palette stays neutral throughout — no alarming green-when-on /
 * red-when-off tint.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";
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
  /**
   * Delegated modules (cycle/coach): the real control lives elsewhere. When
   * set, the row renders a read-only deep-link instead of a Switch.
   * `label` is the destination name; `href` the in-app link.
   */
  managedAt?: { href: string; label: string };
  /** Localised "Manage in {section}" link text (managed-elsewhere rows). */
  manageLinkLabel?: string;
  /**
   * Operator turned this module off server-wide. Replaces the Switch with a
   * read-only note; a per-user toggle cannot re-enable it. `operatorNote`
   * is the localised "disabled server-wide" copy.
   */
  operatorDisabled?: boolean;
  operatorNote?: string;
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
  managedAt,
  manageLinkLabel,
  operatorDisabled = false,
  operatorNote,
  pending = false,
  onToggle,
}: ModuleToggleRowProps) {
  const inputId = `module-toggle-${moduleKey}`;
  // A delegated module whose real control lives elsewhere, or an
  // operator-disabled module: either way no live Switch — the per-user
  // toggle would be a dead no-op.
  const managed = managedAt != null;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          {managed ? (
            <p className="text-sm font-medium">{label}</p>
          ) : (
            <Label htmlFor={inputId} className="text-sm font-medium">
              {label}
            </Label>
          )}
          <p className="text-muted-foreground text-xs">{description}</p>
          {locked && lockedNote ? (
            <p className="text-muted-foreground text-xs">{lockedNote}</p>
          ) : null}
        </div>
      </div>
      {operatorDisabled ? (
        // Operator kill-switch: read-only note, no toggle.
        <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">
          {operatorNote}
        </span>
      ) : managed ? (
        // Delegated module: deep-link to the real control instead of a
        // dead toggle.
        <Link
          href={managedAt.href}
          className="text-muted-foreground hover:text-foreground mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs underline-offset-2 hover:underline"
        >
          {manageLinkLabel}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      ) : (
        <Switch
          id={inputId}
          checked={locked ? true : enabled}
          disabled={locked || pending}
          onCheckedChange={locked ? undefined : (v) => onToggle?.(v)}
          className="mt-0.5 shrink-0"
          aria-label={label}
        />
      )}
    </div>
  );
}
