"use client";

import { Trash2 } from "lucide-react";

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

/**
 * Shared single-row delete button + confirm dialog for the data-
 * management lists (measurements + mood). Lifted from the two
 * copy-pasted `DeleteButton` helpers (v1.15.13).
 *
 * The confirm copy differs per surface (a measurement vs a mood entry),
 * so the title/description are passed in rather than reaching for a fixed
 * translation key. `cancelLabel` / `confirmLabel` default to the shared
 * `common.*` strings.
 */
export function DeleteButton({
  onConfirm,
  title,
  description,
  cancelLabel,
  confirmLabel,
  className = "",
  iconClassName = "h-3.5 w-3.5",
}: {
  onConfirm: () => void;
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel?: string;
  className?: string;
  iconClassName?: string;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className={`text-destructive ${className}`}
          aria-label={confirmLabel ?? t("common.delete")}
        >
          <Trash2 className={iconClassName} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {cancelLabel ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel ?? t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
