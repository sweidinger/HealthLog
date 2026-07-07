"use client";

/**
 * The Dokumente vault — one wide, calm, filing-cabinet-fast surface.
 *
 * Filter state lives in the URL (`?q&kind&episode&year`) so every view is
 * shareable, back-button-safe, and deep-linkable from the illness page and
 * labs. Search debounces 200 ms and `/` focuses it. The timeline below is
 * virtualized; uploads appear optimistically above it in < 100 ms.
 *
 * Born-gated on the resolved `modules.inboundDocuments` flag from
 * `GET /api/auth/me` (per-user opt-in AND the operator availability layer).
 * An unauthenticated visitor bounces to login; an account without the
 * module bounces home. Every `/api/documents/inbound/*` route re-enforces
 * the gate server-side — this is a UX redirect, not the security boundary.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  FolderOpen,
  Loader2,
  SearchX,
  Upload,
  UploadCloud,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type { DocumentVaultFilters } from "@/lib/query-keys/documents";
import {
  DOCUMENT_BULK_MAX_IDS,
  type DocumentBulkAction,
  type DocumentBulkResultDto,
  type DocumentUsageDto,
  type InboundDocumentDetailDto,
  type InboundDocumentDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { DocumentBulkBar } from "./document-bulk-bar";
import { DocumentDetailSheet } from "./document-detail-sheet";
import { DocumentFilterBar, type ConditionChip } from "./document-filter-bar";
import { DocumentTimeline } from "./document-timeline";
import { UploadZone } from "./upload-zone";
import { useDocumentUpload } from "./use-document-upload";
import { usePageFileDrop } from "./use-page-file-drop";
import {
  buildVaultListApiSearch,
  countActiveFilters,
  documentDateKey,
  expandRangeSelection,
  parseVaultSearchParams,
  vaultFiltersToSearch,
} from "./vault-utils";

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function DocumentsView() {
  const { t } = useTranslations();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const moduleEnabled = user?.modules?.inboundDocuments === true;

  // UX redirect only — the API routes enforce the gate server-side.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!moduleEnabled) {
      router.push("/");
    }
  }, [authLoading, isAuthenticated, moduleEnabled, router]);

  // ── URL-owned filter state ────────────────────────────────────────────
  const filters = useMemo(
    () => parseVaultSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const applyFilters = useCallback(
    (next: DocumentVaultFilters, mode: "push" | "replace") => {
      const search = vaultFiltersToSearch(next);
      const href = search ? `${pathname}?${search}` : pathname;
      if (mode === "push") {
        router.push(href, { scroll: false });
      } else {
        router.replace(href, { scroll: false });
      }
    },
    [pathname, router],
  );

  // Search draft debounces into the URL (200 ms); an external URL change
  // (back button, deep link) re-seeds the draft — render-phase derived-state
  // adjustment, not an effect.
  const [searchDraft, setSearchDraft] = useState(filters.q ?? "");
  const [lastUrlQ, setLastUrlQ] = useState(filters.q ?? "");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  if ((filters.q ?? "") !== lastUrlQ) {
    setLastUrlQ(filters.q ?? "");
    setSearchDraft(filters.q ?? "");
  }
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === (filters.q ?? "")) return;
      applyFilters(
        { ...filters, q: trimmed === "" ? undefined : trimmed },
        "replace",
      );
    }, 200);
    return () => clearTimeout(handle);
  }, [searchDraft, filters, applyFilters]);

  // `/` focuses the search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleKind = (kind: InboundDocumentKindValue) => {
    const current = new Set(filters.kinds ?? []);
    if (current.has(kind)) {
      current.delete(kind);
    } else {
      current.add(kind);
    }
    applyFilters(
      {
        ...filters,
        kinds: current.size > 0 ? [...current].sort() : undefined,
      },
      "push",
    );
  };

  const toggleEpisode = (episodeId: string) => {
    applyFilters(
      {
        ...filters,
        episodeId: filters.episodeId === episodeId ? undefined : episodeId,
      },
      "push",
    );
  };

  const toggleYear = (year: number) => {
    applyFilters(
      { ...filters, year: filters.year === year ? undefined : year },
      "push",
    );
  };

  const clearFilters = () => {
    setSearchDraft("");
    applyFilters({}, "push");
  };

  // ── Data ──────────────────────────────────────────────────────────────
  const usage = useQuery({
    queryKey: queryKeys.inboundDocumentUsage(),
    enabled: moduleEnabled,
    queryFn: () => apiGet<DocumentUsageDto>("/api/documents/inbound/usage"),
  });

  const list = useInfiniteQuery({
    queryKey: queryKeys.inboundDocumentList(filters),
    enabled: moduleEnabled,
    queryFn: ({ pageParam }) =>
      apiGet<ListPage>(
        `/api/documents/inbound?${buildVaultListApiSearch(filters, pageParam)}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const documents = useMemo(
    () => list.data?.pages.flatMap((p) => p.documents) ?? [],
    [list.data],
  );

  const upload = useDocumentUpload(
    usage.data ? { maxFileBytes: usage.data.maxFileBytes } : undefined,
  );
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // One intake path for every source (picker, zone drop, page-wide drop,
  // clipboard paste): pre-links to the active episode filter and feeds the
  // sr-only live region — the drop overlay itself is decorative.
  const [uploadAnnouncement, setUploadAnnouncement] = useState("");
  const enqueueRef = useRef(upload.enqueue);
  useEffect(() => {
    enqueueRef.current = upload.enqueue;
  }, [upload.enqueue]);
  const episodeIdFilter = filters.episodeId;
  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      enqueueRef.current(files, { episodeId: episodeIdFilter });
      setUploadAnnouncement(
        t("documents.upload.queuedAnnouncement", { count: files.length }),
      );
    },
    [episodeIdFilter, t],
  );
  const { dropActive } = usePageFileDrop(enqueueFiles);

  const episodes = useIllnessEpisodes(true);

  // Condition chips: the user's episodes that actually carry links in the
  // loaded corpus — plus the actively filtered episode (a deep link must
  // always show its own chip, even before its documents load).
  const conditionChips = useMemo<ConditionChip[]>(() => {
    const byId = new Map<string, string>();
    for (const doc of documents) {
      for (const link of doc.conditionLinks) {
        if (!byId.has(link.episodeId)) byId.set(link.episodeId, link.name);
      }
    }
    if (filters.episodeId && !byId.has(filters.episodeId)) {
      const episode = episodes.data?.find((e) => e.id === filters.episodeId);
      byId.set(filters.episodeId, episode?.label ?? filters.episodeId);
    }
    return [...byId.entries()]
      .map(([episodeId, name]) => ({ episodeId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [documents, filters.episodeId, episodes.data]);

  // Year segmenter: years present in the loaded corpus (+ the active year).
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const doc of documents) {
      set.add(Number(documentDateKey(doc).slice(0, 4)));
    }
    if (filters.year !== undefined) set.add(filters.year);
    return [...set].sort((a, b) => b - a);
  }, [documents, filters.year]);

  // ── Selection + bulk actions ──────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Anchor for shift-click ranges: the last plainly-toggled id.
  const rangeAnchorRef = useRef<string | null>(null);
  const toggleSelected = useCallback(
    (id: string, range?: boolean) => {
      setSelectedIds((prev) => {
        if (range) {
          return expandRangeSelection(
            documents.map((d) => d.id),
            prev,
            rangeAnchorRef.current,
            id,
          );
        }
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      if (!range) rangeAnchorRef.current = id;
    },
    [documents],
  );
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    rangeAnchorRef.current = null;
  }, []);

  // Escape clears the selection — unless a dialog/popover owns the key.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, clearSelection]);

  /**
   * One bulk POST per ≤100-id chunk (the endpoint's cap); per-id results
   * are merged so a partial failure in any chunk surfaces once. The
   * endpoint is no-op-success on already-in-state rows, so an undo toast
   * firing twice is safe by contract.
   */
  const bulk = useMutation({
    mutationFn: async (input: {
      ids: string[];
      action: DocumentBulkAction;
      kind?: InboundDocumentKindValue;
      episodeId?: string;
    }) => {
      const results: DocumentBulkResultDto[] = [];
      for (let i = 0; i < input.ids.length; i += DOCUMENT_BULK_MAX_IDS) {
        const chunk = input.ids.slice(i, i + DOCUMENT_BULK_MAX_IDS);
        const page = await apiPost<{ results: DocumentBulkResultDto[] }>(
          "/api/documents/inbound/bulk",
          {
            ids: chunk,
            action: input.action,
            ...(input.kind !== undefined && { kind: input.kind }),
            ...(input.episodeId !== undefined && {
              episodeId: input.episodeId,
            }),
          },
        );
        results.push(...page.results);
      }
      return results;
    },
    onSettled: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });

  const reportBulkOutcome = useCallback(
    (results: DocumentBulkResultDto[], successMessage: string) => {
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        toast.error(
          t("documents.bulk.partialFailure", {
            failed,
            total: results.length,
          }),
        );
      } else {
        toast.success(successMessage);
      }
    },
    [t],
  );

  const runBulk = useCallback(
    (
      action: Exclude<DocumentBulkAction, "delete" | "restore">,
      extra: { kind?: InboundDocumentKindValue; episodeId?: string },
    ) => {
      const ids = [...selectedIds];
      bulk.mutate(
        { ids, action, ...extra },
        {
          onSuccess: (results) => {
            reportBulkOutcome(
              results,
              t("documents.bulk.updated", {
                count: results.filter((r) => r.ok).length,
              }),
            );
            clearSelection();
          },
          onError: () => toast.error(t("documents.bulk.failed")),
        },
      );
    },
    [selectedIds, bulk, reportBulkOutcome, clearSelection, t],
  );

  const restoreBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "restore" },
        {
          onSuccess: (results) =>
            reportBulkOutcome(
              results,
              t("documents.bulk.restored", {
                count: results.filter((r) => r.ok).length,
              }),
            ),
          onError: () => toast.error(t("documents.toast.restoreFailed")),
        },
      );
    },
    [bulk, reportBulkOutcome, t],
  );

  const deleteBulk = useCallback(
    (ids: string[]) => {
      bulk.mutate(
        { ids, action: "delete" },
        {
          onSuccess: (results) => {
            const okIds = results.filter((r) => r.ok).map((r) => r.id);
            const failed = results.length - okIds.length;
            if (failed > 0) {
              toast.error(
                t("documents.bulk.partialFailure", {
                  failed,
                  total: results.length,
                }),
              );
            }
            if (okIds.length > 0) {
              // ONE aggregate undo for the whole batch (bulk restore).
              toast.success(
                t("documents.bulk.deleted", { count: okIds.length }),
                {
                  action: {
                    label: t("common.undo"),
                    onClick: () => restoreBulk(okIds),
                  },
                },
              );
            }
            clearSelection();
          },
          onError: () => toast.error(t("documents.bulk.failed")),
        },
      );
    },
    [bulk, clearSelection, restoreBulk, t],
  );

  // ── Detail sheet ──────────────────────────────────────────────────────
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  }, []);

  // `?doc=<id>` deep link (used by the illness page's document rows): open
  // the detail sheet once per value; closing the sheet strips the param so
  // back/forward and refresh behave. The id is shape-checked before it is
  // interpolated into an API path.
  const docParam = searchParams.get("doc");
  const [consumedDocParam, setConsumedDocParam] = useState<string | null>(null);
  useEffect(() => {
    if (!moduleEnabled || !docParam || docParam === consumedDocParam) return;
    setConsumedDocParam(docParam);
    if (/^[a-zA-Z0-9_-]{1,40}$/.test(docParam)) openDetail(docParam);
  }, [docParam, consumedDocParam, moduleEnabled, openDetail]);

  const handleDetailOpenChange = useCallback(
    (open: boolean) => {
      setDetailOpen(open);
      if (!open && searchParams.get("doc")) {
        const sp = new URLSearchParams(searchParams.toString());
        sp.delete("doc");
        const search = sp.toString();
        router.replace(search ? `${pathname}?${search}` : pathname, {
          scroll: false,
        });
      }
    },
    [pathname, router, searchParams],
  );

  // Hover/focus intent prefetches the detail METADATA (never the blob —
  // the blob fetch starts when the sheet mounts its preview element).
  const prefetchDetail = useCallback(
    (id: string) => {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.inboundDocument(id),
        queryFn: () =>
          apiGet<InboundDocumentDetailDto>(`/api/documents/inbound/${id}`),
        staleTime: 30_000,
      });
    },
    [queryClient],
  );

  if (authLoading || !isAuthenticated || !moduleEnabled) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  const activeCount = countActiveFilters(filters);
  const isFiltered = activeCount > 0;
  const showEmpty =
    list.isSuccess && documents.length === 0 && upload.items.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("documents.title")}
        description={t("documents.subtitle")}
        actions={
          <Button onClick={() => uploadInputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {t("documents.pageUpload")}
          </Button>
        }
      />

      <UploadZone
        usage={usage.data}
        inputRef={uploadInputRef}
        onFiles={enqueueFiles}
      />

      <DocumentFilterBar
        searchValue={searchDraft}
        onSearchChange={setSearchDraft}
        searchInputRef={searchInputRef}
        activeKinds={new Set(filters.kinds ?? [])}
        onToggleKind={toggleKind}
        conditionChips={conditionChips}
        activeEpisodeId={filters.episodeId}
        onToggleEpisode={toggleEpisode}
        years={years}
        activeYear={filters.year}
        onToggleYear={toggleYear}
        activeCount={activeCount}
        onClearAll={clearFilters}
      />

      {list.isPending ? (
        <div
          data-slot="documents-loading"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <QueryErrorCard
          title={t("documents.list.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : showEmpty && !isFiltered ? (
        <EmptyState
          icon={<FolderOpen className="size-6" aria-hidden />}
          title={t("documents.empty.title")}
          description={t("documents.empty.description")}
          ctaSize="lg"
          action={
            <Button onClick={() => uploadInputRef.current?.click()}>
              <Upload className="size-4" aria-hidden />
              {t("documents.empty.action")}
            </Button>
          }
        />
      ) : showEmpty && isFiltered ? (
        <EmptyState
          icon={<SearchX className="size-6" aria-hidden />}
          title={t("documents.empty.noMatchesTitle")}
          description={t("documents.empty.noMatchesDescription")}
          action={
            <Button variant="outline" onClick={clearFilters}>
              {t("documents.filter.clear")}
            </Button>
          }
        />
      ) : (
        <DocumentTimeline
          documents={documents}
          uploadItems={upload.items}
          onDismissUpload={upload.dismiss}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          selectedIds={selectedIds}
          onToggleSelected={toggleSelected}
          onOpen={openDetail}
          onDelete={(id) => deleteBulk([id])}
          highlightId={upload.highlightId}
          onPrefetch={prefetchDetail}
        />
      )}

      <DocumentDetailSheet
        documentId={detailId}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
      />

      {selectedIds.size > 0 ? (
        <DocumentBulkBar
          selectedCount={selectedIds.size}
          episodes={(episodes.data ?? []).map((e) => ({
            id: e.id,
            label: e.label,
          }))}
          busy={bulk.isPending}
          onSetKind={(kind) => runBulk("setKind", { kind })}
          onLinkEpisode={(episodeId) => runBulk("linkEpisode", { episodeId })}
          onDelete={() => deleteBulk([...selectedIds])}
          onClear={clearSelection}
        />
      ) : null}

      {/* Page-wide drop overlay — pure decoration (aria-hidden); the intake
          itself announces through the live region below. */}
      {dropActive ? (
        <div
          aria-hidden
          data-slot="document-drop-overlay"
          className="bg-background/80 fixed inset-0 z-50 p-4 backdrop-blur-sm md:p-8"
        >
          <div className="border-primary bg-primary/5 flex h-full items-center justify-center rounded-xl border-2 border-dashed">
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <UploadCloud className="text-primary size-8" aria-hidden />
              <p className="text-base font-medium">
                {t("documents.dropOverlay.title")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("documents.dropOverlay.hint")}
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <p aria-live="polite" role="status" className="sr-only">
        {uploadAnnouncement}
      </p>
    </div>
  );
}
