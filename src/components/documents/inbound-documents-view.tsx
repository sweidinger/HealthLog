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
import { useEffect, useRef, useState } from "react";
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
  Search,
  Sparkles,
  Upload,
} from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiFetch, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
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
  formatDateGroupLabel,
  groupDocumentsByDate,
  isProviderUnsupportedError,
} from "./library-utils";

type ListResponse = {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
};
type Decision = "approve" | "reject";

export function InboundDocumentsView() {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // Upload form metadata (filed with the document immediately).
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadKind, setUploadKind] =
    useState<InboundDocumentKindValue>("DOCTOR_REPORT");
  const [uploadDate, setUploadDate] = useState("");

  // Library toolbar state.
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | InboundDocumentKindValue>(
    "",
  );
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
  const isFiltered = Boolean(filters.q || filters.kind);

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
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      setSelectedId(doc.id);
      setUploadTitle("");
      setUploadDate("");
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: () => toast.error(t("documents.toast.uploadFailed")),
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
              <Input
                id="doc-date"
                type="date"
                value={uploadDate}
                onChange={(e) => setUploadDate(e.target.value)}
                disabled={upload.isPending}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="doc-file">
                {t("documents.upload.fileLabel")}
              </Label>
              <Input
                id="doc-file"
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                disabled={upload.isPending}
              />
            </div>
          </div>
          <div>
            <Button
              onClick={() => {
                const file = fileRef.current?.files?.[0];
                if (file) upload.mutate(file);
              }}
              disabled={upload.isPending}
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
          </div>
        </CardContent>
      </Card>

      {/* Toolbar — search / category filter / sort. */}
      <div
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        data-slot="documents-toolbar"
      >
        <div className="flex flex-1 flex-col gap-1">
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
        ) : documents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {isFiltered
              ? t("documents.list.noResults")
              : t("documents.list.empty")}
          </p>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-2">
                <h2
                  className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
                  data-slot="documents-date-group"
                >
                  {formatDateGroupLabel(group.key, locale)}
                </h2>
                {group.documents.map((doc) => (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    expanded={selectedId === doc.id}
                    onToggle={() =>
                      setSelectedId(selectedId === doc.id ? null : doc.id)
                    }
                  />
                ))}
                {selectedId &&
                group.documents.some((d) => d.id === selectedId) ? (
                  <DocumentDetail
                    documentId={selectedId}
                    onClosed={() => setSelectedId(null)}
                  />
                ) : null}
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
  onToggle,
}: {
  doc: InboundDocumentDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslations();
  const display = doc.title ?? doc.filename ?? t(`documents.kind.${doc.kind}`);

  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      data-slot="documents-row"
      className="hover:bg-accent flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{display}</span>
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {t(`documents.kind.${doc.kind}`)}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
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
}: {
  documentId: string;
  onClosed: () => void;
}) {
  const { t } = useTranslations();
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
      // A missing provider is not an error the user can fix here — surface the
      // calm inline note (rendered below) instead of an alarming toast.
      if (!isProviderUnsupportedError(err)) {
        toast.error(t("documents.toast.extractFailed"));
      }
    },
  });

  const confirm = useMutation({
    mutationFn: () =>
      apiPost(`/api/documents/inbound/${documentId}/confirm`, {
        decisions: Object.entries(decisions).map(([factId, action]) => ({
          factId,
          action,
        })),
      }),
    onSuccess: () => {
      toast.success(t("documents.toast.confirmed"));
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
  const decidedCount = Object.keys(decisions).length;
  const canExtract = doc.status !== "CONFIRMED";
  const showProviderNote = isProviderUnsupportedError(extract.error);

  return (
    <Card data-slot="documents-detail">
      <CardHeader className="flex-col items-start gap-2 space-y-0">
        <CardTitle className="text-base">{doc.title ?? doc.filename}</CardTitle>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => discard.mutate()}
            disabled={discard.isPending}
          >
            {t("documents.detail.discard")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {showProviderNote ? <ProviderUnsupportedNote /> : null}

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
        ) : (
          <p className="text-muted-foreground text-sm">
            {doc.factCount > 0
              ? t("documents.empty.noFacts")
              : t("documents.detail.notExtracted")}
          </p>
        )}
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

/** The calm inline note shown when extraction needs a provider that's absent. */
export function ProviderUnsupportedNote() {
  const { t } = useTranslations();
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200"
      data-slot="documents-provider-note"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{t("documents.note.providerUnsupported")}</p>
    </div>
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
        <Input
          id="edit-doc-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
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
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {t(`documents.factType.${fact.factType}`)}
            </Badge>
            {fact.needsReview ? (
              // Calm warning (amber), not an alarming destructive red — a
              // low-confidence fact is a "please check", not an error.
              <Badge
                variant="outline"
                className="border-amber-400 text-amber-700 dark:border-amber-900/60 dark:text-amber-400"
              >
                {t("documents.review.needsReview")}
              </Badge>
            ) : null}
            <span className="text-muted-foreground text-xs">
              {Math.round(fact.confidence * 100)}%
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-medium">{summary}</p>
          {fact.provenance.sourceText ? (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-xs italic">
              “{fact.provenance.sourceText}”
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant={decision === "approve" ? "default" : "outline"}
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={fact.needsReview}
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
  fields,
  dateValue,
  pending,
  onSubmit,
}: {
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
          <Label htmlFor={`edit-${f.key}`} className="text-xs">
            {f.label}
          </Label>
          <Input
            id={`edit-${f.key}`}
            value={vals[f.key] ?? ""}
            onChange={(e) =>
              setVals((p) => ({ ...p, [f.key]: e.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="edit-date" className="text-xs">
          {t("documents.fields.date")}
        </Label>
        <Input
          id="edit-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
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
