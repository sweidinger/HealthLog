"use client";

/**
 * A destructive settings control that asks first.
 *
 * The security card's "sign out everywhere" and its per-row revoke, and the
 * same pair on trusted devices, fired on a single tap with no confirmation —
 * while every other destructive surface in the app confirms. Signing every
 * other device out is not recoverable by an undo; the other devices simply
 * have to log in again, and on a shared screen a mis-tap is a support call.
 *
 * Wrapping the pattern rather than inlining a fourth dialog is the point: the
 * next destructive control gets the confirmation by using this, instead of by
 * someone remembering to add one.
 *
 * The copy contract matches the rest of the app after the delete-confirmation
 * sweep — say what happens, and claim no more finality than is true. Callers
 * pass their own body text so each control can be specific about its own
 * consequence.
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "@/lib/i18n/context";

export function ConfirmButton({
  label,
  title,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  disabled = false,
  size,
  variant = "outline",
  className,
  icon,
  ariaLabel,
  slot,
}: {
  /** The control's own label, before the dialog opens. */
  label: string;
  title: string;
  body: string;
  /** The dialog's action label. Names the act, not "OK". */
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  disabled?: boolean;
  size?: "sm" | "icon";
  variant?: "outline" | "ghost";
  className?: string;
  /** For an icon-only control, where `label` renders as an icon. */
  ariaLabel?: string;
  icon?: ReactNode;
  /** `data-slot` for tests and the design guards. */
  slot?: string;
}) {
  const { t } = useTranslations();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          aria-label={ariaLabel}
          data-slot={slot}
          disabled={disabled || pending}
        >
          {pending ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            icon
          )}
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-slot={slot ? `${slot}-confirm` : undefined}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={onConfirm}
          >
            {pending && (
              <Loader2 className="mr-1 size-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
