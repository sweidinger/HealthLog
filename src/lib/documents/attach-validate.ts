/**
 * v1.29.x (S7) — the ONE place a candidate document id is validated before a
 * coach-conversation attachment (join row) is created. Used by BOTH the
 * first-turn create path (`POST /api/insights/chat/fenced` with `attachmentIds`)
 * and the mid-conversation attach endpoint (`POST /api/insights/chat/{id}/
 * attachments`), so the two cannot drift.
 *
 * Fail-closed, owner-scoped:
 *   - owned + live  — `{ id, userId, deletedAt: null }`. A miss (nonexistent,
 *                     foreign, or soft-deleted) is a 404 indistinguishable from
 *                     nonexistence — no cross-user existence oracle.
 *   - content-indexed — the chat grounds on the indexed text; an un-indexed
 *                       attachment is a 422, never a partial-context reply.
 *   - within cap    — current live join count + incoming ≤ MAX_COACH_ATTACHMENTS.
 */
import { prisma } from "@/lib/db";
import { MAX_COACH_ATTACHMENTS } from "@/lib/validations/inbound-documents";

export type AttachValidation =
  { ok: true } | { ok: false; status: 404 | 422; errorCode: string };

/**
 * Validate that `documentId` (owned by `userId`) can be attached, given the
 * conversation's CURRENT live attachment count. `incoming` is how many rows this
 * request adds (1 for the attach endpoint; the batch size for first-turn create).
 */
export async function validateAttachmentCandidate(args: {
  userId: string;
  documentId: string;
  currentLiveCount: number;
  incoming?: number;
}): Promise<AttachValidation> {
  const doc = await prisma.inboundDocument.findFirst({
    where: { id: args.documentId, userId: args.userId, deletedAt: null },
    select: { id: true, contentIndex: { select: { documentId: true } } },
  });
  if (!doc) {
    return { ok: false, status: 404, errorCode: "documents.inbound.notFound" };
  }
  if (!doc.contentIndex) {
    return {
      ok: false,
      status: 422,
      errorCode: "coach.fenced.attachmentNotIndexed",
    };
  }
  if (args.currentLiveCount + (args.incoming ?? 1) > MAX_COACH_ATTACHMENTS) {
    return {
      ok: false,
      status: 422,
      errorCode: "coach.fenced.attachmentLimit",
    };
  }
  return { ok: true };
}
