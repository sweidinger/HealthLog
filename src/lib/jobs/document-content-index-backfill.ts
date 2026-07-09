/**
 * v1.27.22 (Document vault P2) — content-search index backfill.
 *
 * Indexes a user's EXISTING stored documents for content search: for each live
 * document that has no `DocumentContentIndex` yet, run one provider vision
 * transcription and upsert the encrypted-text + blind-token index. On-demand
 * only (fired by the "index all documents" action) — NOT a boot/cron pass:
 * indexing egresses to a provider under the user's key + budget, so it must be
 * a deliberate, consented act, exactly like the per-document index route.
 *
 * Consent: gated on the document-egress consent (`assertDocumentEgressConsent`),
 * the same gate the extract / index routes use — any external provider needs an
 * active receipt; a local pick stays ungated. There is no separate per-user
 * toggle (maintainer decision, 2026-07-07).
 *
 * Bounded + resumable: an id-cursor forward walk over the not-yet-indexed set,
 * capped at `MAX_DOCS_PER_RUN` provider calls per job and stopped the moment the
 * daily AI budget is reached. Only vision-indexable MIME types (image + PDF when
 * the provider reads PDFs) are candidates, so the walk converges — an
 * un-indexable file never re-queues work. A re-run picks up where budget /
 * the cap left off because already-indexed documents drop out of the set.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  assertDocumentEgressConsent,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { prisma } from "@/lib/db";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import { upsertContentIndex } from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";

export const CONTENT_INDEX_BACKFILL_QUEUE = "document-content-index-backfill";

/** Serial concurrency — provider calls, kept off the request pool. */
export const CONTENT_INDEX_BACKFILL_CONCURRENCY = 1;

/** Discovery page size (id-only; blobs are loaded one at a time). */
const PAGE_SIZE = 50;

/** Max documents one job indexes before yielding (bounds spend + runtime). */
const MAX_DOCS_PER_RUN = 200;

/** Image MIME types the vision path can always index. */
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ContentIndexBackfillPayload {
  userId: string;
  enqueuedAt?: string;
}

export interface ContentIndexBackfillSummary {
  indexed: number;
  reason: "ok" | "no-provider" | "no-consent" | "budget-reached";
}

/**
 * Index one user's not-yet-indexed documents. Idempotent + resumable: an
 * already-indexed document drops out of the candidate set, and the run stops at
 * the per-run cap or when the budget is reached.
 */
export async function runContentIndexBackfillForUser(
  userId: string,
): Promise<ContentIndexBackfillSummary> {
  const { pick } = await resolveDocumentVisionProvider(userId);
  if (!pick) return { indexed: 0, reason: "no-provider" };
  try {
    await assertDocumentEgressConsent({
      userId,
      providerType: pick.providerType,
      surface: "insights",
    });
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      return { indexed: 0, reason: "no-consent" };
    }
    throw err;
  }

  const candidateMimes = pick.pdfSupported
    ? [...IMAGE_MIMES, "application/pdf"]
    : [...IMAGE_MIMES];

  const dailyCap = resolveDailyCap([{ providerType: pick.entry.providerType }]);
  let indexed = 0;
  let reason: ContentIndexBackfillSummary["reason"] = "ok";
  let cursor: string | null = null;

  outer: for (;;) {
    if (indexed >= MAX_DOCS_PER_RUN) break;
    const rows: { id: string }[] = await prisma.inboundDocument.findMany({
      where: {
        userId,
        deletedAt: null,
        mimeType: { in: candidateMimes },
        contentIndex: { is: null },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const { id } of rows) {
      if (indexed >= MAX_DOCS_PER_RUN) break outer;

      const dateKey = buildDateKey();
      const reservation = await reserveBudget(
        userId,
        AI_BUDGETS.documentTranscribe.maxTokens,
        dateKey,
        dailyCap,
      );
      if (!reservation.allowed) {
        reason = "budget-reached";
        break outer;
      }

      const document = await loadOwnedDocument(userId, id);
      if (!document) {
        await reconcileSpend(userId, reservation.reserved, 0, dateKey);
        continue;
      }
      const vision = await prepareVisionInput(document, pick.pdfSupported);
      if (!vision.ok) {
        // Not vision-indexable (should be filtered by MIME, but guard) — refund
        // and move the cursor past it so the walk keeps converging.
        await reconcileSpend(userId, reservation.reserved, 0, dateKey);
        continue;
      }

      try {
        const { text } = await transcribeDocument({
          provider: pick.entry.instance,
          providerType: pick.providerType,
          images: vision.images,
          documents: vision.documents,
        });
        await reconcileSpend(
          userId,
          reservation.reserved,
          reservation.reserved,
          dateKey,
        );
        await upsertContentIndex({
          userId,
          documentId: document.id,
          text,
          source: "vision",
          providerType: pick.providerType,
        });
        indexed += 1;
      } catch {
        // A provider miss on one document must not abort the batch — refund and
        // leave it un-indexed (a later run retries it).
        await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }

  annotate({
    action: { name: "documents.contentIndex.backfill" },
    meta: { indexed, reason },
  });
  return { indexed, reason };
}

/**
 * Enqueue a per-user content-index backfill. Coalesced by `singletonKey` so a
 * user cannot pile up parallel runs; returns whether a job was created.
 */
export async function enqueueContentIndexBackfill(
  userId: string,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: ContentIndexBackfillPayload = {
    userId,
    enqueuedAt: new Date().toISOString(),
  };
  const jobId = await boss.send(CONTENT_INDEX_BACKFILL_QUEUE, payload, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    singletonKey: `document-content-index-backfill|${userId}`,
  });
  return { enqueued: Boolean(jobId) };
}
