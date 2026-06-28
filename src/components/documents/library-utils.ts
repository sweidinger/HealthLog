/**
 * v1.25 — pure helpers for the documents library (search-param building, date
 * grouping, provider-unsupported classification). Kept out of the client
 * component so they stay trivially unit-testable without a render harness.
 */
import { ApiError } from "@/lib/api/api-fetch";
import type { DocumentListParams } from "@/lib/query-keys/documents";
import {
  DOCUMENT_LIST_DEFAULT_LIMIT,
  type InboundDocumentDto,
} from "@/lib/validations/inbound-documents";

/**
 * Build the `/api/documents/inbound` query string from the active filters and
 * a keyset cursor. Empty / undefined fields are omitted so the URL stays clean
 * and the server applies its own defaults. The cursor is the `nextCursor` the
 * previous page returned (null on the first page).
 */
export function buildDocumentListSearch(
  params: DocumentListParams,
  cursor: string | null,
  limit: number = DOCUMENT_LIST_DEFAULT_LIMIT,
): string {
  const sp = new URLSearchParams();
  if (params.q && params.q.trim() !== "") sp.set("q", params.q.trim());
  if (params.kind) sp.set("kind", params.kind);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  sp.set("sort", params.sort);
  sp.set("order", params.order);
  sp.set("limit", String(limit));
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

/** The date a document files under — its user filing date, else its upload day. */
export function documentDateKey(doc: InboundDocumentDto): string {
  if (doc.documentDate) return doc.documentDate;
  // createdAt is an ISO timestamp; the leading YYYY-MM-DD is the upload day.
  return doc.createdAt.slice(0, 10);
}

export interface DocumentDateGroup {
  /** The YYYY-MM-DD key the group files under. */
  key: string;
  documents: InboundDocumentDto[];
}

/**
 * Group an already-sorted document list into consecutive date buckets,
 * preserving the server's sort order. A document's bucket is its `documentDate`
 * (fallback: its upload day). The first time a date appears it opens a new
 * group; later documents on the same date join it. Order is preserved exactly
 * as received, so the server stays the single source of truth for sorting.
 */
export function groupDocumentsByDate(
  documents: InboundDocumentDto[],
): DocumentDateGroup[] {
  const groups: DocumentDateGroup[] = [];
  let current: DocumentDateGroup | null = null;
  for (const doc of documents) {
    const key = documentDateKey(doc);
    if (!current || current.key !== key) {
      current = { key, documents: [doc] };
      groups.push(current);
    } else {
      current.documents.push(doc);
    }
  }
  return groups;
}

/**
 * True when an error is the extract route's 422 "no document-scan provider
 * configured" signal. The UI surfaces this as a calm inline note (configure a
 * provider) rather than a hard error toast — the stored document is untouched.
 */
export function isProviderUnsupportedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.meta?.errorCode === "documents.inbound.providerUnsupported"
  );
}

/**
 * True when an error is the extract route's 422 "this document has already been
 * confirmed" signal. Re-extraction is refused server-side once any fact has
 * been committed; the UI surfaces this as a calm inline note rather than a hard
 * error toast, and hides the Extract control to match.
 */
export function isAlreadyConfirmedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.meta?.errorCode === "documents.inbound.alreadyConfirmed"
  );
}

/** Format a YYYY-MM-DD group key into a locale-aware medium date label. */
export function formatDateGroupLabel(key: string, locale: string): string {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      date,
    );
  } catch {
    return key;
  }
}
