"use client";

/**
 * Document detail on `ResponsiveSheet` (bottom sheet on phones, dialog on
 * desktop). Inline-class documents (PDF / browser-native images) preview
 * inline against the owner-scoped decrypt-and-serve route — skeleton first,
 * content on load, internal scroll only (`overscroll-contain`). Attachment-
 * class documents get NO fake preview: type glyph, filename, size, and a
 * prominent Download button.
 *
 * Metadata edits save on commit (title on Enter/blur, kind and filing date
 * on change, condition links on toggle — replace-set PATCH). Mutation
 * errors surface inline (`role="alert"`), never as a QueryErrorCard.
 * Delete soft-deletes with an Undo toast (restore endpoint); a restore
 * refusal maps `meta.reason` (`purged`, `duplicateExists`) to translated
 * copy. No share affordance anywhere — deliberately.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  apiDelete,
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  INBOUND_DOCUMENT_KINDS,
  type InboundDocumentDetailDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS } from "./document-kind-meta";
import { formatBytes } from "./vault-utils";

type PatchInput = {
  title?: string | null;
  kind?: InboundDocumentKindValue;
  documentDate?: string | null;
  episodeIds?: string[];
};

/** Inline preview for Class A documents; skeleton until the blob paints. */
function InlinePreview({
  documentId,
  mimeType,
  title,
}: {
  documentId: string;
  mimeType: string;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = `/api/documents/inbound/${documentId}/original`;
  const isPdf = mimeType === "application/pdf";

  return (
    <div className="relative max-h-[55vh] overflow-auto overscroll-contain rounded-lg">
      {!loaded ? (
        <Skeleton
          className={cn("w-full rounded-lg", isPdf ? "h-[55vh]" : "h-64")}
        />
      ) : null}
      {isPdf ? (
        // No `sandbox` attribute by design: Chromium force-downloads PDFs
        // in sandboxed frames instead of rendering them. The serve
        // response itself carries `default-src 'none'` +
        // `frame-ancestors 'self'` + true Content-Type + nosniff, and the
        // upload policy denies every format whose inline render could
        // execute script.
        <iframe
          src={src}
          title={title}
          onLoad={() => setLoaded(true)}
          className={cn(
            "border-border h-[55vh] w-full rounded-lg border",
            !loaded && "absolute inset-0 opacity-0",
          )}
        />
      ) : (
        // Decrypted same-origin blob stream: next/image cannot optimise it
        // and would only proxy the bytes through a second request.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={title}
          onLoad={() => setLoaded(true)}
          className={cn(
            "mx-auto max-h-[55vh] w-auto max-w-full rounded-lg object-contain",
            !loaded && "absolute inset-0 opacity-0",
          )}
        />
      )}
    </div>
  );
}

export function DocumentDetailSheet({
  documentId,
  open,
  onOpenChange,
}: {
  documentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: queryKeys.inboundDocument(documentId ?? "none"),
    enabled: open && documentId !== null,
    queryFn: () =>
      apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${documentId}`),
  });
  const doc = detail.data;

  const episodes = useIllnessEpisodes(true);

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Reset transient edit state whenever another document opens —
  // render-phase derived-state adjustment, not an effect.
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  if (lastDocumentId !== documentId) {
    setLastDocumentId(documentId);
    setEditingTitle(false);
    setMutationError(null);
  }

  const patch = useMutation({
    mutationFn: (input: PatchInput) =>
      apiPatch<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}`,
        input,
      ),
    onSuccess: () => {
      setMutationError(null);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: () => setMutationError(t("documents.detail.saveError")),
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      apiPost(`/api/documents/inbound/${id}/restore`, {}),
    onSuccess: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: (error) => {
      const reason =
        error instanceof ApiError && typeof error.meta?.reason === "string"
          ? error.meta.reason
          : "";
      if (reason === "purged") {
        toast.error(t("documents.error.purged"));
      } else if (reason === "duplicateExists") {
        toast.error(t("documents.error.duplicateExists"));
      } else {
        toast.error(t("documents.toast.restoreFailed"));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/documents/inbound/${id}`),
    onSuccess: (_data, id) => {
      onOpenChange(false);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      toast.success(t("documents.toast.deleted"), {
        action: {
          label: t("common.undo"),
          onClick: () => restore.mutate(id),
        },
      });
    },
    onError: () => setMutationError(t("documents.detail.deleteError")),
  });

  const commitTitle = () => {
    if (!doc) return;
    setEditingTitle(false);
    const next = titleDraft.trim();
    const current = doc.title ?? "";
    if (next === current) return;
    patch.mutate({ title: next === "" ? null : next });
  };

  const toggleEpisode = (episodeId: string) => {
    if (!doc) return;
    const current = doc.conditionLinks.map((l) => l.episodeId);
    const next = current.includes(episodeId)
      ? current.filter((id) => id !== episodeId)
      : [...current, episodeId];
    patch.mutate({ episodeIds: next });
  };

  const title = doc?.title ?? doc?.filename ?? t("documents.card.untitled");
  const Icon = doc ? DOCUMENT_KIND_ICONS[doc.kind] : null;
  const originalHref = doc ? `/api/documents/inbound/${doc.id}/original` : "#";

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={t("documents.detail.title")}
      contentWidth="3xl"
      footer={
        doc ? (
          <>
            <Button variant="outline" asChild data-slot="document-download">
              <a href={originalHref} download={doc.filename ?? undefined}>
                <Download className="size-4" aria-hidden />
                {t("documents.detail.download")}
              </a>
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate(doc.id)}
              disabled={remove.isPending}
            >
              <Trash2 className="size-4" aria-hidden />
              {t("documents.detail.delete")}
            </Button>
          </>
        ) : undefined
      }
    >
      {detail.isPending && open ? (
        <div className="space-y-3" data-slot="document-detail-loading">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-9 w-1/2" />
        </div>
      ) : null}

      {detail.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("documents.detail.loadError")}
        </p>
      ) : null}

      {doc ? (
        <div className="space-y-6">
          {doc.servingClass === "inline" ? (
            <InlinePreview
              documentId={doc.id}
              mimeType={doc.mimeType}
              title={title}
            />
          ) : (
            <div className="border-border flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center">
              {Icon ? (
                <Icon className="text-muted-foreground size-8" aria-hidden />
              ) : null}
              <p className="max-w-full truncate text-sm font-medium">
                {doc.filename ?? title}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("documents.detail.previewUnavailable")} ·{" "}
                {formatBytes(doc.byteSize, locale)}
              </p>
              <Button asChild size="sm" className="mt-1">
                <a href={originalHref} download={doc.filename ?? undefined}>
                  <Download className="size-4" aria-hidden />
                  {t("documents.detail.download")}
                </a>
              </Button>
            </div>
          )}

          {mutationError ? (
            <p role="alert" className="text-destructive text-sm">
              {mutationError}
            </p>
          ) : null}

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="document-title-input">
                {t("documents.detail.titleLabel")}
              </Label>
              {editingTitle ? (
                <Input
                  id="document-title-input"
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTitle();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  maxLength={200}
                  placeholder={t("documents.detail.titlePlaceholder")}
                />
              ) : (
                <button
                  type="button"
                  id="document-title-input"
                  onClick={() => {
                    setTitleDraft(doc.title ?? "");
                    setEditingTitle(true);
                  }}
                  className="border-input hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-10 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "truncate",
                      doc.title === null && "text-muted-foreground",
                    )}
                  >
                    {doc.title ?? t("documents.detail.titlePlaceholder")}
                  </span>
                  <Pencil
                    className="text-muted-foreground size-3.5 shrink-0"
                    aria-hidden
                  />
                </button>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="document-kind-select">
                  {t("documents.detail.kindLabel")}
                </Label>
                <Select
                  value={doc.kind}
                  onValueChange={(value) =>
                    patch.mutate({ kind: value as InboundDocumentKindValue })
                  }
                >
                  <SelectTrigger id="document-kind-select" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INBOUND_DOCUMENT_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {t(`documents.kind.${kind}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="document-date-field">
                  {t("documents.detail.dateLabel")}
                </Label>
                <DateField
                  id="document-date-field"
                  value={doc.documentDate ?? ""}
                  onChange={(value) =>
                    patch.mutate({ documentDate: value === "" ? null : value })
                  }
                  aria-label={t("documents.detail.dateLabel")}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm leading-none font-medium">
                {t("documents.detail.conditionsLabel")}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {doc.conditionLinks.map((link) => (
                  <Link
                    key={link.episodeId}
                    href={`/illness/${link.episodeId}`}
                    className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-48 items-center rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
                  >
                    <span className="truncate">{link.name}</span>
                  </Link>
                ))}
                {doc.conditionLinks.length === 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {t("documents.detail.noConditions")}
                  </span>
                ) : null}
                {(episodes.data?.length ?? 0) > 0 ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-full px-2.5 text-xs"
                      >
                        <Plus className="size-3" aria-hidden />
                        {t("documents.detail.linkCondition")}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 p-2">
                      <ul className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain">
                        {episodes.data?.map((episode) => {
                          const linked = doc.conditionLinks.some(
                            (l) => l.episodeId === episode.id,
                          );
                          return (
                            <li key={episode.id}>
                              <button
                                type="button"
                                onClick={() => toggleEpisode(episode.id)}
                                className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                                aria-pressed={linked}
                              >
                                <Check
                                  className={cn(
                                    "size-4 shrink-0",
                                    linked ? "opacity-100" : "opacity-0",
                                  )}
                                  aria-hidden
                                />
                                <span className="truncate">
                                  {episode.label}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
            </div>

            <p className="text-muted-foreground text-xs">
              {t("documents.detail.uploadedMeta", {
                date: format.date(doc.createdAt),
                size: formatBytes(doc.byteSize, locale),
              })}
              {doc.filename ? ` · ${doc.filename}` : ""}
            </p>
          </div>
        </div>
      ) : null}
    </ResponsiveSheet>
  );
}
