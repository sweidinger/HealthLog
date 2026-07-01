"use client";

/**
 * v1.25 — Documents library.
 *
 * A self-hoster files any clinical document (doctor report, discharge letter,
 * lab result, imaging, prescription, …). Upload is STORE-ONLY and always works,
 * even with no AI provider configured — a file is filed with optional title /
 * category / filing date. The library groups documents by date, with search, a
 * category filter, sort, and keyset pagination.
 *
 * Each document opens a detail panel: view / download the original, edit its
 * metadata, optionally run AI extraction (the explicit, separate enhancement),
 * then review-then-confirm the STRUCTURED FACTS the provider transcribed before
 * any reaches the structured stores. The screen reproduces what the document
 * stated — it never interprets. A low-confidence fact fails closed: it cannot
 * be approved until the user edits it. Absent a provider, extraction surfaces a
 * calm inline note (configure one) — never a hard error; the stored document is
 * untouched.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ExternalLink,
  FileScan,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiFetch, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type { DocumentListParams } from "@/lib/query-keys/documents";
import {
  DOCUMENT_LIST_SORTS,
  INBOUND_DOCUMENT_KINDS,
  type ConditionFactData,
  type DocumentListSort,
  type ExtractedFactDto,
  type InboundDocumentDetailDto,
  type InboundDocumentDto,
  type InboundDocumentKindValue,
  type MedicationStatementFactData,
  type ObservationFactData,
} from "@/lib/validations/inbound-documents";
import {
  buildDocumentListSearch,
  classifyUploadError,
  confirmFailureReasonKey,
  formatDateGroupLabel,
  groupDocumentsByDate,
  isAlreadyConfirmedError,
  isLocalOcrDisabledError,
  isProviderUnsupportedError,
  MAX_UPLOAD_BYTES,
} from "./library-utils";

type ListResponse = {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
};
/** Shape the confirm route returns (HTTP 200) — `failed[]` carries per-fact
 *  commit misses the client must surface, not silently swallow. */
type ConfirmResponse = {
  approved: { factId: string; recordType: string; recordId: string }[];
  rejected: string[];
  needsReview: string[];
  failed: { factId: string; reason: string }[];
};
type Decision = "approve" | "reject";

export function InboundDocumentsView() {
  const { t } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // Upload form metadata (filed with the document immediately).
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadKind, setUploadKind] =
    useState<InboundDocumentKindValue>("DOCTOR_REPORT");
  const [uploadDate, setUploadDate] = useState("");
  // Tracks whether a file is staged in the (uncontrolled) file input so the
  // upload button can stay disabled until there's something to upload.
  const [hasFile, setHasFile] = useState(false);

  // Library toolbar state.
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | InboundDocumentKindValue>(
    "",
  );
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState<DocumentListSort>("documentDate");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounce the search box so a query fires per pause, not per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(handle);
  }, [q]);

  const filters: DocumentListParams = {
    q: debouncedQ.trim() || undefined,
    kind: kindFilter || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    sort,
    order,
  };

  const list = useInfiniteQuery({
    queryKey: queryKeys.inboundDocumentList(filters),
    queryFn: ({ pageParam }) =>
      apiFetch<ListResponse>(
        `/api/documents/inbound?${buildDocumentListSearch(filters, pageParam)}`,
        { method: "GET" },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const documents = list.data?.pages.flatMap((p) => p.documents) ?? [];
  const groups = groupDocumentsByDate(documents);
  const isFiltered = Boolean(
    filters.q || filters.kind || filters.from || filters.to,
  );

  // Reset search + every filter to the default view. Used by the no-results
  // "Clear filters" affordance and after an upload (so the just-stored document
  // is in the list the detail panel opens against).
  const clearFilters = () => {
    setQ("");
    setDebouncedQ("");
    setKindFilter("");
    setFromDate("");
    setToDate("");
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", uploadKind);
      if (uploadTitle.trim()) fd.append("title", uploadTitle.trim());
      if (uploadDate) fd.append("documentDate", uploadDate);
      return apiFetch<InboundDocumentDto>("/api/documents/inbound", {
        method: "POST",
        body: fd,
        signal: null,
      });
    },
    onSuccess: (doc) => {
      toast.success(t("documents.toast.uploaded"));
      // Drop any active filter / search so the just-stored document is in the
      // list — otherwise selecting it opens a detail panel for a row the current
      // filter excludes, and the user lands on a dead end. Sort by date-added
      // (createdAt) desc, NOT documentDate: a user-set past documentDate would
      // otherwise file the fresh upload deep in the list, off page 1, where the
      // detail panel never renders. The newest upload always has the newest
      // createdAt, so this guarantees it lands first and its panel opens.
      clearFilters();
      setSort("createdAt");
      setOrder("desc");
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      setSelectedId(doc.id);
      setUploadTitle("");
      setUploadDate("");
      setHasFile(false);
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (error) => {
      switch (classifyUploadError(error)) {
        case "tooLarge":
          toast.error(t("documents.toast.uploadTooLarge"));
          break;
        case "fileType":
          toast.error(t("documents.toast.uploadFileType"));
          break;
        case "rateLimited":
          toast.error(t("documents.toast.uploadRateLimited"));
          break;
        case "invalidMetadata":
          toast.error(t("documents.toast.uploadInvalidMetadata"));
          break;
        default:
          toast.error(t("documents.toast.uploadFailed"));
      }
    },
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      <header className="flex items-center gap-3">
        <FileScan className="text-primary h-6 w-6" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">{t("documents.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("documents.subtitle")}
          </p>
        </div>
      </header>

      {/* Upload — store-only, always available. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("documents.upload.label")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* The one required field goes first and full-width, with the
                accepted formats + size ceiling beside it (so the limit is known
                before an upload fails). */}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="doc-file">
                {t("documents.upload.fileLabel")}
              </Label>
              <Input
                id="doc-file"
                ref={fileRef}
                type="file"
                required
                accept="image/jpeg,image/png,image/webp,application/pdf"
                aria-describedby="doc-file-hint"
                disabled={upload.isPending}
                onChange={(e) => setHasFile(Boolean(e.target.files?.length))}
              />
              <p id="doc-file-hint" className="text-muted-foreground text-xs">
                {t("documents.upload.accepts")}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="doc-title">
                {t("documents.upload.titleLabel")}
              </Label>
              <Input
                id="doc-title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder={t("documents.upload.titlePlaceholder")}
                disabled={upload.isPending}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="doc-kind">
                {t("documents.upload.kindLabel")}
              </Label>
              <NativeSelect
                id="doc-kind"
                value={uploadKind}
                onChange={(e) =>
                  setUploadKind(e.target.value as InboundDocumentKindValue)
                }
                disabled={upload.isPending}
              >
                {INBOUND_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`documents.kind.${k}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="doc-date">
                {t("documents.upload.dateLabel")}
              </Label>
              <DateField
                id="doc-date"
                value={uploadDate}
                onChange={setUploadDate}
                disabled={upload.isPending}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                const file = fileRef.current?.files?.[0];
                if (!file) return;
                // Reject an oversized file before it is sent, so the user gets
                // the size message immediately instead of after a full upload.
                if (file.size > MAX_UPLOAD_BYTES) {
                  toast.error(t("documents.toast.uploadTooLarge"));
                  return;
                }
                upload.mutate(file);
              }}
              disabled={upload.isPending || !hasFile}
            >
              {upload.isPending ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <Upload className="h-4 w-4" aria-hidden />
              )}
              {upload.isPending
                ? t("documents.upload.uploading")
                : t("documents.upload.button")}
            </Button>
            {!hasFile && !upload.isPending ? (
              <p className="text-muted-foreground text-sm">
                {t("documents.upload.fileRequired")}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Toolbar — search / category filter / sort. */}
      <div
        className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-end"
        data-slot="documents-toolbar"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label htmlFor="doc-search">
            {t("documents.toolbar.searchLabel")}
          </Label>
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              id="doc-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("documents.toolbar.searchPlaceholder")}
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="doc-kind-filter">
            {t("documents.toolbar.kindFilterLabel")}
          </Label>
          <NativeSelect
            id="doc-kind-filter"
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as "" | InboundDocumentKindValue)
            }
          >
            <option value="">{t("documents.toolbar.allKinds")}</option>
            {INBOUND_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`documents.kind.${k}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="doc-from">{t("documents.toolbar.fromLabel")}</Label>
          <DateField
            id="doc-from"
            value={fromDate}
            max={toDate || undefined}
            onChange={setFromDate}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="doc-to">{t("documents.toolbar.toLabel")}</Label>
          <DateField
            id="doc-to"
            value={toDate}
            min={fromDate || undefined}
            onChange={setToDate}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="doc-sort">{t("documents.toolbar.sortLabel")}</Label>
          <div className="flex items-center gap-1">
            <NativeSelect
              id="doc-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as DocumentListSort)}
            >
              {DOCUMENT_LIST_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`documents.toolbar.sort.${s}`)}
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              size="icon"
              aria-label={t(
                order === "asc"
                  ? "documents.toolbar.orderAsc"
                  : "documents.toolbar.orderDesc",
              )}
              onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}
            >
              {order === "asc" ? (
                <ArrowUpAZ className="h-4 w-4" aria-hidden />
              ) : (
                <ArrowDownAZ className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Library list — grouped by date, keyset-paginated. */}
      <section className="flex flex-col gap-4" data-slot="documents-library">
        {list.isLoading ? (
          // Skeleton rows (not a centered spinner) so the resolved list lands
          // in place without a layout jump — the app's loading convention.
          <div className="flex flex-col gap-2" data-slot="documents-loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          // A failed list load is its own state with a retry — never the
          // "no documents yet" empty state, which would falsely imply the
          // library is empty.
          <div
            role="alert"
            data-slot="documents-list-error"
            className="text-muted-foreground flex flex-col items-start gap-3 py-4 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{t("documents.list.loadError")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void list.refetch()}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              <span>{t("common.retry")}</span>
            </Button>
          </div>
        ) : documents.length === 0 ? (
          isFiltered ? (
            <div
              className="flex flex-col items-start gap-2"
              data-slot="documents-no-results"
            >
              <p className="text-muted-foreground text-sm">
                {t("documents.list.noResults")}
              </p>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("documents.list.clearFilters")}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("documents.list.empty")}
            </p>
          )
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-2">
                <h2
                  className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
                  data-slot="documents-date-group"
                >
                  {formatDateGroupLabel(group.key, format.date)}
                </h2>
                {group.documents.map((doc) => {
                  const expanded = selectedId === doc.id;
                  // Shared id ties the row's aria-controls to the detail
                  // region so screen readers know the row owns the panel; the
                  // panel renders directly after its row for correct order.
                  const detailId = `documents-detail-${doc.id}`;
                  return (
                    <Fragment key={doc.id}>
                      <DocumentRow
                        doc={doc}
                        expanded={expanded}
                        regionId={detailId}
                        onToggle={() => setSelectedId(expanded ? null : doc.id)}
                      />
                      {expanded ? (
                        <DocumentDetail
                          regionId={detailId}
                          documentId={doc.id}
                          onClosed={() => setSelectedId(null)}
                        />
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            ))}

            {list.hasNextPage ? (
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? (
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : null}
                {list.isFetchingNextPage
                  ? t("documents.list.loadingMore")
                  : t("documents.list.loadMore")}
              </Button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/** A single library row — title (or filename), kind + status badges, counts. */
function DocumentRow({
  doc,
  expanded,
  regionId,
  onToggle,
}: {
  doc: InboundDocumentDto;
  expanded: boolean;
  regionId: string;
  onToggle: () => void;
}) {
  const { t } = useTranslations();
  const display = doc.title ?? doc.filename ?? t(`documents.kind.${doc.kind}`);

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={regionId}
      onClick={onToggle}
      data-slot="documents-row"
      className="hover:bg-accent flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{display}</span>
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {t(`documents.kind.${doc.kind}`)}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {t(`documents.status.${doc.status}`)}
          </Badge>
        </span>
      </span>
      {doc.pendingCount > 0 ? (
        <Badge variant="outline" className="shrink-0">
          {t("documents.list.pending", { count: doc.pendingCount })}
        </Badge>
      ) : doc.factCount > 0 ? (
        <Badge variant="secondary" className="shrink-0">
          {t("documents.list.facts", { count: doc.factCount })}
        </Badge>
      ) : null}
    </button>
  );
}

export function DocumentDetail({
  documentId,
  onClosed,
  regionId,
}: {
  documentId: string;
  onClosed: () => void;
  regionId?: string;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [editOpen, setEditOpen] = useState(false);

  const detail = useQuery({
    queryKey: queryKeys.inboundDocument(documentId),
    queryFn: () =>
      apiFetch<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}`,
        { method: "GET" },
      ),
  });

  const extract = useMutation({
    // Empty body → vision mode over the stored original.
    mutationFn: () =>
      apiPost(`/api/documents/inbound/${documentId}/extract`, undefined),
    onSuccess: () => {
      toast.success(t("documents.toast.extracted"));
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: (err) => {
      // A missing provider — or a document already confirmed elsewhere — is not
      // an error the user acts on here. Surface the calm inline note (rendered
      // below) instead of an alarming toast.
      if (isProviderUnsupportedError(err) || isAlreadyConfirmedError(err)) {
        return;
      }
      // Local OCR switched off in settings: name the cause rather than the
      // generic "couldn't extract".
      if (isLocalOcrDisabledError(err)) {
        toast.error(t("documents.toast.localOcrDisabled"));
        return;
      }
      toast.error(t("documents.toast.extractFailed"));
    },
  });

  const confirm = useMutation({
    mutationFn: (): Promise<ConfirmResponse> =>
      apiPost<ConfirmResponse>(`/api/documents/inbound/${documentId}/confirm`, {
        decisions: Object.entries(decisions).map(([factId, action]) => ({
          factId,
          action,
        })),
      }),
    onSuccess: (data) => {
      // The route returns HTTP 200 even when it rejects a fact into `failed[]`
      // (e.g. a stated unit that disagrees with the saved marker). A green
      // "saved" toast would lie — the fact stays PENDING. Surface the count +
      // reason so the user knows to reconcile it, and only show the plain
      // success when nothing failed.
      const failed = data.failed ?? [];
      if (failed.length > 0) {
        toast.warning(
          t("documents.toast.confirmedPartial", {
            count: failed.length,
            reason: t(confirmFailureReasonKey(failed)),
          }),
        );
      } else {
        toast.success(t("documents.toast.confirmed"));
      }
      setDecisions({});
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
    onError: () => toast.error(t("documents.toast.confirmFailed")),
  });

  const discard = useMutation({
    mutationFn: () => apiDelete(`/api/documents/inbound/${documentId}`),
    onSuccess: () => {
      toast.success(t("documents.toast.discarded"));
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      onClosed();
    },
    onError: () => toast.error(t("documents.toast.discardFailed")),
  });

  if (detail.isLoading) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-20" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full rounded-md" />
          <Skeleton className="h-20 w-full rounded-md" />
        </CardContent>
      </Card>
    );
  }
  if (!detail.data) return null;

  const doc = detail.data;
  const pending = doc.facts.filter((f) => f.status === "PENDING");
  // Facts already approved from this document and pushed to the structured
  // stores — surfaced read-only below so the document ↔ committed-record link
  // stays visible after review (instead of the panel going blank).
  const approved = doc.facts.filter((f) => f.status === "APPROVED");
  const decidedCount = Object.keys(decisions).length;
  // Mirror the backend's hard guard: extraction is gone once the document is
  // confirmed OR any fact on it has already been approved (re-extracting would
  // clash with facts already committed to the structured stores).
  const hasApprovedFact = doc.facts.some((f) => f.status === "APPROVED");
  const canExtract = doc.status !== "CONFIRMED" && !hasApprovedFact;
  const showProviderNote = isProviderUnsupportedError(extract.error);
  const showAlreadyConfirmedNote = isAlreadyConfirmedError(extract.error);
  const detailTitle =
    doc.title ?? doc.filename ?? t(`documents.kind.${doc.kind}`);

  return (
    <Card id={regionId} data-slot="documents-detail">
      <CardHeader className="flex-col items-start gap-2 space-y-0">
        <CardTitle className="text-base">{detailTitle}</CardTitle>
        <div className="flex flex-wrap items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            {/* Same-origin, cookie-authenticated: a new tab carries the
                session; a PDF / image renders inline, other types download. */}
            <a
              href={`/api/documents/inbound/${documentId}/original`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t("documents.detail.viewOriginal")}
              <span className="sr-only">
                {" "}
                {t("documents.detail.viewOriginalNewTab")}
              </span>
            </a>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditOpen(true)}
            data-slot="documents-edit-trigger"
          >
            <Pencil className="h-4 w-4" aria-hidden />
            {t("documents.detail.edit")}
          </Button>
          {canExtract ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => extract.mutate()}
              disabled={extract.isPending}
              data-slot="documents-extract"
            >
              {extract.isPending ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden />
              )}
              {extract.isPending
                ? t("documents.detail.extracting")
                : t("documents.detail.extract")}
            </Button>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={discard.isPending}
                data-slot="documents-discard-trigger"
              >
                {discard.isPending ? (
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : null}
                {t("documents.detail.discard")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("documents.detail.discardConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("documents.detail.discardConfirmBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("documents.detail.discardCancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={discard.isPending}
                  aria-busy={discard.isPending || undefined}
                  onClick={() => discard.mutate()}
                >
                  {t("documents.detail.discardConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {showProviderNote ? <ProviderUnsupportedNote /> : null}
        {showAlreadyConfirmedNote ? <AlreadyConfirmedNote /> : null}

        {pending.length > 0 ? (
          <>
            <p className="text-muted-foreground text-sm">
              {t("documents.review.title")}
            </p>
            {pending.map((fact) => (
              <FactCard
                key={fact.id}
                documentId={documentId}
                fact={fact}
                decision={decisions[fact.id]}
                onDecision={(d) =>
                  setDecisions((prev) => {
                    const next = { ...prev };
                    if (d === null) delete next[fact.id];
                    else next[fact.id] = d;
                    return next;
                  })
                }
              />
            ))}
            <Separator />
            <Button
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending || decidedCount === 0}
            >
              {confirm.isPending
                ? t("documents.review.confirming")
                : t("documents.review.confirm")}
            </Button>
          </>
        ) : approved.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {doc.factCount > 0
              ? t("documents.empty.noFacts")
              : t("documents.detail.notExtracted")}
          </p>
        ) : null}

        {approved.length > 0 ? (
          <div className="flex flex-col gap-2" data-slot="documents-committed">
            <Separator />
            <p className="text-muted-foreground text-sm">
              {t("documents.committed.title")}
            </p>
            <ul className="flex flex-col gap-1">
              {approved.map((fact) => {
                const when = factDate(fact);
                return (
                  <li
                    key={fact.id}
                    className="text-muted-foreground truncate text-sm"
                  >
                    {factSummary(fact)}
                    {when ? ` · ${format.date(`${when}T12:00:00.000Z`)}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("documents.edit.title")}</DialogTitle>
            <DialogDescription>
              {t("documents.edit.subtitle")}
            </DialogDescription>
          </DialogHeader>
          <DocumentMetaEditForm
            doc={doc}
            onSaved={() => setEditOpen(false)}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * A calm inline note. Carries `role="status"` + `aria-live="polite"` so that
 * keyboard / screen-reader users hear it when it appears — these notes stand in
 * for a toast that the mutation deliberately suppresses.
 */
function InlineNote({ slot, children }: { slot: string; children: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-info/30 bg-info/10 text-info flex items-start gap-2 rounded-md border p-3 text-sm"
      data-slot={slot}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

/** The calm inline note shown when extraction needs a provider that's absent. */
export function ProviderUnsupportedNote() {
  const { t } = useTranslations();
  return (
    <InlineNote slot="documents-provider-note">
      {t("documents.note.providerUnsupported")}
    </InlineNote>
  );
}

/** Calm inline note when extraction is refused — the document is confirmed. */
export function AlreadyConfirmedNote() {
  const { t } = useTranslations();
  return (
    <InlineNote slot="documents-already-confirmed-note">
      {t("documents.note.alreadyConfirmed")}
    </InlineNote>
  );
}

/** Metadata edit (rename / recategorise / set the filing date). PATCHes. */
export function DocumentMetaEditForm({
  doc,
  onSaved,
  onCancel,
}: {
  doc: InboundDocumentDto;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(doc.title ?? "");
  const [kind, setKind] = useState<InboundDocumentKindValue>(doc.kind);
  const [date, setDate] = useState(doc.documentDate ?? "");

  const save = useMutation({
    mutationFn: () =>
      apiPatch(`/api/documents/inbound/${doc.id}`, {
        title: title.trim() === "" ? null : title.trim(),
        kind,
        documentDate: date === "" ? null : date,
      }),
    onSuccess: () => {
      toast.success(t("documents.toast.updated"));
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      onSaved();
    },
    onError: () => toast.error(t("documents.toast.updateFailed")),
  });

  return (
    <div className="flex flex-col gap-3" data-slot="documents-edit-form">
      <div className="flex flex-col gap-1">
        <Label htmlFor="edit-doc-title">{t("documents.edit.titleLabel")}</Label>
        <Input
          id="edit-doc-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("documents.upload.titlePlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="edit-doc-kind">{t("documents.edit.kindLabel")}</Label>
        <NativeSelect
          id="edit-doc-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as InboundDocumentKindValue)}
        >
          {INBOUND_DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`documents.kind.${k}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="edit-doc-date">{t("documents.edit.dateLabel")}</Label>
        <DateField id="edit-doc-date" value={date} onChange={setDate} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={save.isPending}>
          {t("documents.edit.cancel")}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending
            ? t("documents.edit.saving")
            : t("documents.edit.save")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function FactCard({
  documentId,
  fact,
  decision,
  onDecision,
}: {
  documentId: string;
  fact: ExtractedFactDto;
  decision: Decision | undefined;
  onDecision: (d: Decision | null) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const summary = factSummary(fact);

  const save = useMutation({
    mutationFn: (payload: unknown) =>
      apiPatch(
        `/api/documents/inbound/${documentId}/facts/${fact.id}`,
        payload,
      ),
    onSuccess: () => {
      toast.success(t("documents.toast.saved"));
      setEditing(false);
      void invalidateKeys(queryClient, [queryKeys.inboundDocument(documentId)]);
    },
  });

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {t(`documents.factType.${fact.factType}`)}
            </Badge>
            {fact.needsReview ? (
              // A calm, neutral "please check" — not an alarming red, and not
              // amber (the app is moving away from amber warning tints). A
              // low-confidence fact is a gentle nudge to review, not an error.
              <Badge
                variant="outline"
                className="border-foreground/25 text-muted-foreground"
              >
                {t("documents.review.needsReview")}
              </Badge>
            ) : null}
            <span
              className="text-muted-foreground text-xs"
              title={t("documents.review.confidenceLabel")}
            >
              <span className="sr-only">
                {t("documents.review.confidenceLabel")}:{" "}
              </span>
              {format.percent(fact.confidence)}
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-medium">{summary}</p>
          {fact.provenance.sourceText ? (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-xs italic">
              “{fact.provenance.sourceText}”
            </p>
          ) : null}
          {fact.needsReview ? (
            // Ties the disabled Approve button to the "Needs review" badge: a
            // low-confidence fact must be edited before it can be approved.
            <p className="text-muted-foreground mt-1 text-xs">
              {t("documents.review.needsReviewHint")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant={decision === "approve" ? "default" : "outline"}
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={fact.needsReview}
            title={
              fact.needsReview
                ? t("documents.review.needsReviewHint")
                : undefined
            }
            onClick={() =>
              onDecision(decision === "approve" ? null : "approve")
            }
          >
            {t("documents.review.approve")}
          </Button>
          <Button
            variant={decision === "reject" ? "destructive" : "outline"}
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDecision(decision === "reject" ? null : "reject")}
          >
            {t("documents.review.reject")}
          </Button>
        </div>
      </div>

      <div className="mt-2">
        <Button
          variant="ghost"
          size="xs"
          className="min-h-11 sm:min-h-8"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? t("documents.review.cancel") : t("documents.review.edit")}
        </Button>
      </div>

      {editing ? (
        <FactEditForm
          fact={fact}
          pending={save.isPending}
          onSubmit={(payload) => save.mutate(payload)}
        />
      ) : null}
    </div>
  );
}

function FactEditForm({
  fact,
  pending,
  onSubmit,
}: {
  fact: ExtractedFactDto;
  pending: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const { t } = useTranslations();

  if (fact.factType === "CONDITION") {
    const d = fact.data as ConditionFactData;
    return (
      <EditFields
        idPrefix={fact.id}
        pending={pending}
        fields={[
          { key: "label", label: t("documents.fields.label"), value: d.label },
        ]}
        dateValue={d.onsetDate}
        onSubmit={(vals, date) =>
          onSubmit({
            factType: "CONDITION",
            label: vals.label,
            onsetDate: date,
          })
        }
      />
    );
  }
  if (fact.factType === "OBSERVATION") {
    const d = fact.data as ObservationFactData;
    return (
      <EditFields
        idPrefix={fact.id}
        pending={pending}
        fields={[
          { key: "label", label: t("documents.fields.label"), value: d.label },
          {
            key: "value",
            label: t("documents.fields.value"),
            value: d.value !== null ? String(d.value) : (d.valueText ?? ""),
          },
          {
            key: "unit",
            label: t("documents.fields.unit"),
            value: d.unit ?? "",
          },
        ]}
        dateValue={d.effectiveDate}
        onSubmit={(vals, date) => {
          const numeric = Number(vals.value);
          const isNum = vals.value.trim() !== "" && !Number.isNaN(numeric);
          onSubmit({
            factType: "OBSERVATION",
            label: vals.label,
            value: isNum ? numeric : null,
            valueText: isNum ? null : vals.value || null,
            unit: vals.unit || null,
            effectiveDate: date,
          });
        }}
      />
    );
  }
  const d = fact.data as MedicationStatementFactData;
  return (
    <EditFields
      idPrefix={fact.id}
      pending={pending}
      fields={[
        { key: "name", label: t("documents.fields.label"), value: d.name },
        { key: "dose", label: t("documents.fields.dose"), value: d.dose ?? "" },
      ]}
      dateValue={d.effectiveDate}
      onSubmit={(vals, date) =>
        onSubmit({
          factType: "MEDICATION_STATEMENT",
          name: vals.name,
          dose: vals.dose || null,
          effectiveDate: date,
        })
      }
    />
  );
}

function EditFields({
  idPrefix,
  fields,
  dateValue,
  pending,
  onSubmit,
}: {
  // Per-fact id namespace so simultaneously-open editors never share DOM ids
  // (which would break every label's htmlFor → focus association).
  idPrefix: string;
  fields: { key: string; label: string; value: string }[];
  dateValue: string | null;
  pending: boolean;
  onSubmit: (vals: Record<string, string>, date: string | null) => void;
}) {
  const { t } = useTranslations();
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.value])),
  );
  const [date, setDate] = useState<string>(dateValue ?? "");

  return (
    <div className="mt-2 flex flex-col gap-2 border-t pt-2">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <Label htmlFor={`edit-${idPrefix}-${f.key}`} className="text-xs">
            {f.label}
          </Label>
          <Input
            id={`edit-${idPrefix}-${f.key}`}
            value={vals[f.key] ?? ""}
            onChange={(e) =>
              setVals((p) => ({ ...p, [f.key]: e.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`edit-${idPrefix}-date`} className="text-xs">
          {t("documents.fields.date")}
        </Label>
        <DateField
          id={`edit-${idPrefix}-date`}
          value={date}
          onChange={setDate}
        />
      </div>
      <Button
        size="sm"
        className="min-h-11 sm:min-h-9"
        disabled={pending}
        onClick={() => onSubmit(vals, date.trim() === "" ? null : date)}
      >
        {t("documents.review.save")}
      </Button>
    </div>
  );
}

/** A one-line transcription summary of a staged fact (no interpretation). */
function factSummary(fact: ExtractedFactDto): string {
  if (fact.factType === "OBSERVATION") {
    const d = fact.data as ObservationFactData;
    const v =
      d.value !== null
        ? `${d.value}${d.unit ? ` ${d.unit}` : ""}`
        : d.valueText;
    return v ? `${d.label}: ${v}` : d.label;
  }
  if (fact.factType === "MEDICATION_STATEMENT") {
    const d = fact.data as MedicationStatementFactData;
    return d.dose ? `${d.name} — ${d.dose}` : d.name;
  }
  const d = fact.data as ConditionFactData;
  return d.label;
}

/** The effective / onset date a staged fact carries, if any (YYYY-MM-DD). */
function factDate(fact: ExtractedFactDto): string | null {
  if (fact.factType === "CONDITION") {
    return (fact.data as ConditionFactData).onsetDate;
  }
  if (fact.factType === "OBSERVATION") {
    return (fact.data as ObservationFactData).effectiveDate;
  }
  return (fact.data as MedicationStatementFactData).effectiveDate;
}
