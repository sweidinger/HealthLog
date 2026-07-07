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
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FolderOpen, Loader2, SearchX, Upload, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useIllnessEpisodes } from "@/components/illness/use-illness";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { DocumentVaultFilters } from "@/lib/query-keys/documents";
import type {
  DocumentUsageDto,
  InboundDocumentDetailDto,
  InboundDocumentDto,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { DocumentDetailSheet } from "./document-detail-sheet";
import { DocumentFilterBar, type ConditionChip } from "./document-filter-bar";
import { DocumentTimeline } from "./document-timeline";
import { UploadZone } from "./upload-zone";
import { useDocumentUpload } from "./use-document-upload";
import {
  buildVaultListApiSearch,
  countActiveFilters,
  documentDateKey,
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

  // ── Selection (bulk actions attach to this in a follow-up) ───────────
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // ── Detail sheet ──────────────────────────────────────────────────────
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  }, []);

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
        onFiles={(files) =>
          upload.enqueue(files, { episodeId: filters.episodeId })
        }
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

      {selectedIds.size > 0 ? (
        <div
          data-slot="document-selection-bar"
          className="flex items-center justify-between gap-3"
        >
          <p className="text-sm font-medium">
            {t("documents.selection.count", { count: selectedIds.size })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            <X className="size-3.5" aria-hidden />
            {t("documents.selection.clear")}
          </Button>
        </div>
      ) : null}

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
          highlightId={upload.highlightId}
          onPrefetch={prefetchDetail}
        />
      )}

      <DocumentDetailSheet
        documentId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}
