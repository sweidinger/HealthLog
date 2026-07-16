"use client";

import { FileText, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.29.x (S7) — the attachment pills row that sits above the Coach composer on
 * a FENCED conversation. Each pill names one attached document (its resolved
 * title, truncated) with a remove control. A freshly uploaded document that is
 * still being content-indexed renders in an `indexing` state (spinner + a muted
 * "Indexing…" tag); the parent blocks send while any pill is indexing because
 * the fenced endpoint 422s on an un-indexed attachment.
 *
 * Purely presentational — the parent (`<CoachConversation>`) owns whether a
 * remove mutates local pending state (a not-yet-created chat) or calls the
 * detach endpoint (an existing conversation).
 */
export interface AttachmentPillItem {
  documentId: string;
  title: string;
  /** True while the document's content index is still being built. */
  indexing?: boolean;
}

export interface AttachmentPillsProps {
  items: AttachmentPillItem[];
  onRemove: (documentId: string) => void;
  /** Disables every remove control (e.g. while a turn streams). */
  disabled?: boolean;
  className?: string;
}

export function AttachmentPills({
  items,
  onRemove,
  disabled = false,
  className,
}: AttachmentPillsProps) {
  const { t } = useTranslations();
  if (items.length === 0) return null;

  return (
    <div
      data-slot="coach-attachment-pills"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {items.map((item) => (
        <span
          key={item.documentId}
          data-slot="coach-attachment-pill"
          data-indexing={item.indexing ? "true" : undefined}
          className={cn(
            "border-border/60 bg-muted/40 text-foreground",
            "inline-flex max-w-[15rem] items-center gap-1.5 rounded-full border py-0.5 pr-0.5 pl-2.5 text-xs",
          )}
        >
          {item.indexing ? (
            <Loader2
              className="text-muted-foreground size-3 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <FileText
              className="text-primary size-3 shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="truncate font-medium">{item.title}</span>
          {item.indexing ? (
            <span className="text-muted-foreground shrink-0">
              {t("insights.coach.attach.indexing")}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => onRemove(item.documentId)}
            data-slot="coach-attachment-pill-remove"
            aria-label={t("insights.coach.attach.pillRemove", {
              title: item.title,
            })}
            title={t("insights.coach.attach.pillRemove", { title: item.title })}
            className="text-muted-foreground hover:text-foreground size-5 shrink-0 rounded-full"
          >
            <X className="size-3" aria-hidden="true" />
          </Button>
        </span>
      ))}
    </div>
  );
}
