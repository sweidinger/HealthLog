"use client";

/**
 * Floating bulk-action bar for the vault's multi-select mode. Appears once
 * at least one document is selected, pinned above the bottom nav on phones
 * and near the bottom edge on desktop. Carries the selected count and the
 * four bulk verbs — set type, link condition, delete (undo-able), clear —
 * all driving `POST /api/documents/inbound/bulk` from the page.
 *
 * A `role="toolbar"` with proper labels; the destructive verb sits last
 * before Clear so a stray tap sequence never ends on Delete. The bar is a
 * deliberate hand-rolled shell (a floating toolbar is not a Card surface):
 * dense-tile padding `p-3` per the standards.
 */
import { FolderPlus, Tag, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS, DOCUMENT_KIND_ORDER } from "./document-kind-meta";

export interface BulkEpisodeOption {
  id: string;
  label: string;
}

export function DocumentBulkBar({
  selectedCount,
  episodes,
  busy,
  onSetKind,
  onLinkEpisode,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  /** The caller's live illness episodes — the link-condition targets. */
  episodes: BulkEpisodeOption[];
  /** A bulk call is in flight — the verbs disable, Clear stays live. */
  busy: boolean;
  onSetKind: (kind: InboundDocumentKindValue) => void;
  onLinkEpisode: (episodeId: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="document-bulk-bar"
      role="toolbar"
      aria-label={t("documents.bulk.barLabel")}
      className={cn(
        "bg-card border-border fixed bottom-20 left-1/2 z-40 -translate-x-1/2 md:bottom-6",
        "flex w-[calc(100%-2rem)] max-w-2xl flex-wrap items-center gap-2 rounded-xl border p-3 shadow-lg",
      )}
    >
      <p className="px-1 text-sm font-medium whitespace-nowrap" role="status">
        {t("documents.selection.count", { count: selectedCount })}
      </p>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy}>
              <Tag className="size-4" aria-hidden />
              {t("documents.bulk.setKind")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {DOCUMENT_KIND_ORDER.map((kind) => {
              const Icon = DOCUMENT_KIND_ICONS[kind];
              return (
                <DropdownMenuItem key={kind} onSelect={() => onSetKind(kind)}>
                  <Icon className="size-4" aria-hidden />
                  {t(`documents.kind.${kind}`)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {episodes.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>
                <FolderPlus className="size-4" aria-hidden />
                {t("documents.bulk.linkCondition")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {episodes.map((episode) => (
                <DropdownMenuItem
                  key={episode.id}
                  onSelect={() => onLinkEpisode(episode.id)}
                >
                  <span className="max-w-56 truncate">{episode.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {/* Solid destructive (matching the detail sheet's Delete) — the
            outline variant's destructive text on the card surface fails the
            WCAG contrast gate. */}
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden />
          {t("documents.bulk.delete")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onClear}
        >
          <X className="size-3.5" aria-hidden />
          {t("documents.selection.clear")}
        </Button>
      </div>
    </div>
  );
}
