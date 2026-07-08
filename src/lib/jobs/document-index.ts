/**
 * Automatic per-document content indexing, enqueued the moment a document is
 * stored (`POST /api/documents/inbound`). Fire-and-forget: the upload response
 * never blocks on or fails because of indexing.
 *
 * The job runs the shared AI-first decision tree (`indexDocumentContent`):
 * provider (vision) first when one is configured + consented, else local
 * text-layer extraction. Owner-scoped; the provider path is consent + budget
 * gated; the local path needs neither (no egress). Serial concurrency keeps the
 * provider calls + PDF parsing off the request pool.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { indexDocumentContent } from "@/lib/documents/index-document";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const DOCUMENT_INDEX_QUEUE = "document-index";

/** Serial concurrency — provider calls + PDF parse, kept off the request pool. */
export const DOCUMENT_INDEX_CONCURRENCY = 1;

export interface DocumentIndexPayload {
  userId: string;
  documentId: string;
  enqueuedAt?: string;
}

/**
 * Index one document (owner-scoped, provider-first/local-fallback). Never
 * throws for an expected outcome — the decision tree returns a tagged result —
 * so pg-boss does not retry a document that simply has no indexable text.
 */
export async function runDocumentIndex(
  payload: DocumentIndexPayload,
): Promise<void> {
  const { userId, documentId } = payload;
  if (!userId || !documentId) return;
  const outcome = await indexDocumentContent(userId, documentId);
  annotate({
    action: { name: "documents.autoIndex.run" },
    meta: outcome.indexed
      ? { documentId, indexed: true, source: outcome.source }
      : { documentId, indexed: false, reason: outcome.reason },
  });
}

/**
 * Enqueue a per-document index job. Coalesced by `singletonKey` per document so
 * a duplicate/idempotent re-upload cannot pile up parallel runs. Fire-and-
 * forget — a missing boss (worker not up) is a no-op, and a `boss.send` failure
 * (a transient DB hiccup) is swallowed to a no-op too, so enqueue can NEVER fail
 * an already-stored upload. Indexing is a background nicety; the stored document
 * is the contract. A dropped enqueue is recoverable via the corpus backfill.
 */
export async function enqueueDocumentIndex(
  userId: string,
  documentId: string,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: DocumentIndexPayload = {
    userId,
    documentId,
    enqueuedAt: new Date().toISOString(),
  };
  try {
    const jobId = await boss.send(DOCUMENT_INDEX_QUEUE, payload, {
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: `document-index|${documentId}`,
    });
    return { enqueued: Boolean(jobId) };
  } catch (err) {
    annotate({
      action: { name: "documents.autoIndex.enqueueFailed" },
      meta: { documentId, reason: err instanceof Error ? err.name : "unknown" },
    });
    return { enqueued: false };
  }
}
