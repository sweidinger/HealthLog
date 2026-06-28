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
 * True when an error is the extract route's "already confirmed" signal. Two
 * shapes reach here:
 *   - 409 `alreadyPartlyConfirmed` — some facts approved, the rest still pending;
 *   - 422 `alreadyConfirmed` — the whole document is CONFIRMED (a cross-tab race
 *     can fire Extract against a document a second tab just finished confirming).
 * Re-extraction is refused server-side in both cases; the UI surfaces a calm
 * inline note rather than a hard error toast, and hides the Extract control to
 * match.
 */
export function isAlreadyConfirmedError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = error.meta?.errorCode;
  return (
    code === "documents.inbound.alreadyPartlyConfirmed" ||
    code === "documents.inbound.alreadyConfirmed"
  );
}

/**
 * True when an extract failure is the route's "local OCR not enabled" signal
 * (`documents.inbound.localOcrDisabled`, 422). The TEXT extract path refuses
 * when in-browser OCR is switched off in settings; surface a clear message that
 * names the setting rather than the generic "couldn't extract" toast.
 */
export function isLocalOcrDisabledError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.meta?.errorCode === "documents.inbound.localOcrDisabled"
  );
}

/**
 * Map a per-fact commit-failure code to the i18n key for its plain-language
 * reason. The confirm route returns HTTP 200 even when it rejects a fact into
 * its `failed[]` array (e.g. a stated unit that disagrees with the saved
 * marker), so the client must surface why — otherwise the fact silently stays
 * PENDING with the user told nothing.
 */
export function commitFailureReasonKey(code: string): string {
  switch (code) {
    case "observation.unitMismatch":
      return "documents.review.commitError.unitMismatch";
    case "observation.unitRequired":
      return "documents.review.commitError.unitRequired";
    default:
      return "documents.review.commitError.generic";
  }
}

/**
 * Pick the single reason key that best describes a batch of failed facts: the
 * shared reason when every failure agrees, else a generic fallback. Used to
 * build the partial-failure toast after a confirm that rejected one or more
 * facts server-side.
 */
export function confirmFailureReasonKey(failed: { reason: string }[]): string {
  const codes = new Set(failed.map((f) => f.reason));
  if (codes.size === 1) return commitFailureReasonKey([...codes][0]);
  return "documents.review.commitError.generic";
}

/**
 * Client-side upload ceiling. Mirrors the server's `OCR_MAX_BYTES` (12 MB) so an
 * oversized file is rejected before it is sent, instead of after a full upload
 * round-trips and returns 413.
 */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * The class of an upload (`POST /api/documents/inbound`) failure. The route
 * reports precise, actionable codes the generic toast would throw away; this
 * maps them to a stable kind so the view can show the right message and keep
 * every `t()` key a literal call site.
 */
export type UploadErrorKind =
  "tooLarge" | "fileType" | "rateLimited" | "invalidMetadata" | "generic";

/** Classify an upload failure by the route's `errorCode`, then HTTP status. */
export function classifyUploadError(error: unknown): UploadErrorKind {
  if (!(error instanceof ApiError)) return "generic";
  switch (error.meta?.errorCode) {
    case "documents.inbound.fileTooLarge":
      return "tooLarge";
    case "documents.inbound.fileType":
      return "fileType";
    case "documents.inbound.rateLimited":
      return "rateLimited";
    case "documents.inbound.invalidMetadata":
      return "invalidMetadata";
  }
  // A reverse proxy can strip the JSON body (and its `meta`) on some statuses;
  // fall back to the HTTP code so size / type / rate-limit still classify.
  if (error.status === 413) return "tooLarge";
  if (error.status === 415) return "fileType";
  if (error.status === 429) return "rateLimited";
  return "generic";
}

/**
 * Format a YYYY-MM-DD group key into a date label via the app's own date
 * formatter (`useFormatters().date`), so the group headers follow the user's
 * date-format preference (numeric) like the rest of the app instead of a textual
 * `dateStyle: "medium"` month. The key is handed over as a noon-UTC instant so
 * the calendar day never shifts under the display timezone.
 */
export function formatDateGroupLabel(
  key: string,
  formatDate: (value: string) => string,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  return formatDate(`${key}T12:00:00.000Z`);
}
