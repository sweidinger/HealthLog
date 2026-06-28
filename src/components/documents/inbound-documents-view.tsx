"use client";

/**
 * v1.25.0 (W-DOCS-IN) — inbound clinical documents review-then-confirm UI.
 *
 * Upload a doctor report / discharge letter, then review the STRUCTURED FACTS
 * the OCR/vision provider transcribed before any of them reaches the
 * structured stores. The screen reproduces what the document stated — it never
 * interprets. A low-confidence fact fails closed: it cannot be approved until
 * the user edits it. The non-diagnostic disclaimer is shown prominently.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ExternalLink,
  FileScan,
  Loader2,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiFetch, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import {
  INBOUND_DOCUMENT_KINDS,
  type ConditionFactData,
  type ExtractedFactDto,
  type InboundDocumentDetailDto,
  type InboundDocumentDto,
  type InboundDocumentKindValue,
  type MedicationStatementFactData,
  type ObservationFactData,
} from "@/lib/validations/inbound-documents";

type ListResponse = { documents: InboundDocumentDto[] };
type Decision = "approve" | "reject";

export function InboundDocumentsView() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<InboundDocumentKindValue>("DOCTOR_REPORT");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.inboundDocuments(),
    queryFn: () =>
      apiFetch<ListResponse>("/api/documents/inbound", { method: "GET" }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
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

      {/* Non-diagnostic disclaimer — most prominent, always visible. */}
      <Card className="border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div>
            <CardTitle className="text-base">
              {t("documents.disclaimer.title")}
            </CardTitle>
            <CardDescription className="text-amber-900/80 dark:text-amber-200/80">
              {t("documents.disclaimer.body")}
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      {/* Upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("documents.upload.label")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1">
            <Label htmlFor="doc-kind">{t("documents.upload.kindLabel")}</Label>
            <NativeSelect
              id="doc-kind"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as InboundDocumentKindValue)
              }
            >
              {INBOUND_DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`documents.kind.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="max-w-xs"
            aria-label={t("documents.upload.fileLabel")}
            disabled={upload.isPending}
          />
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
        </CardContent>
      </Card>

      {/* Document list */}
      <section className="flex flex-col gap-2">
        {list.isLoading ? (
          // Skeleton rows (not a centered spinner) so the resolved list lands
          // in place without a layout jump — the app's loading convention.
          <>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </>
        ) : !list.data || list.data.documents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("documents.list.empty")}
          </p>
        ) : (
          list.data.documents.map((doc) => (
            <button
              key={doc.id}
              type="button"
              aria-expanded={selectedId === doc.id}
              onClick={() =>
                setSelectedId(selectedId === doc.id ? null : doc.id)
              }
              className="hover:bg-accent flex min-h-11 items-center justify-between rounded-md border px-3 py-2 text-left text-sm"
            >
              <span className="truncate">
                {doc.filename ?? t(`documents.kind.${doc.kind}`)}
              </span>
              <span className="flex items-center gap-2">
                <Badge variant="secondary">
                  {t(`documents.status.${doc.status}`)}
                </Badge>
                {doc.pendingCount > 0 ? (
                  <Badge variant="outline">{doc.pendingCount}</Badge>
                ) : null}
              </span>
            </button>
          ))
        )}
      </section>

      {selectedId ? (
        <DocumentReview
          documentId={selectedId}
          onClosed={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function DocumentReview({
  documentId,
  onClosed,
}: {
  documentId: string;
  onClosed: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  const detail = useQuery({
    queryKey: queryKeys.inboundDocument(documentId),
    queryFn: () =>
      apiFetch<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}`,
        { method: "GET" },
      ),
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

  const pending = detail.data.facts.filter((f) => f.status === "PENDING");
  const decidedCount = Object.keys(decisions).length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {t("documents.review.title")}
        </CardTitle>
        <div className="flex items-center gap-1">
          {/* View the original uploaded document. The route is same-origin and
              cookie-authenticated, so a new tab carries the session; a PDF /
              image renders inline, other types download. */}
          <Button asChild variant="ghost" size="sm">
            <a
              href={`/api/documents/inbound/${documentId}/original`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t("documents.review.viewOriginal")}
            </a>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => discard.mutate()}
            disabled={discard.isPending}
          >
            {t("documents.review.discard")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pending.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("documents.empty.noFacts")}
          </p>
        ) : (
          pending.map((fact) => (
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
          ))
        )}

        {pending.length > 0 ? (
          <>
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
        ) : null}
      </CardContent>
    </Card>
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
