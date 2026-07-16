/**
 * v1.29.x (S7) — detach a document from a coach conversation.
 *
 * DELETE removes the join row. It writes NO flag: a detached conversation stays
 * FENCED (the sticky-flag invariant — a thread whose history may contain
 * document-derived text must never regain the tool loop). The absence of any
 * `documentScoped` write in `detachDocument` is the guarantee, not a guarded
 * branch. Detaching the last pill leaves a fenced conversation with zero
 * attachments; the fenced endpoint still serves it (the coach honestly says it
 * has no document to read from, and the grounding union is empty).
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";

import {
  detachDocument,
  loadConversationAttachmentDTOs,
} from "@/lib/ai/coach/persistence";
import {
  DOCUMENT_CHAT_BUCKET,
  DOCUMENT_CHAT_LIMIT_PER_MINUTE,
  DOCUMENT_CHAT_WINDOW_MS,
} from "@/lib/documents/ai-route-support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; documentId: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id: conversationId, documentId } = await params;

    const rl = await checkRateLimit(
      `${DOCUMENT_CHAT_BUCKET}:${userId}`,
      DOCUMENT_CHAT_LIMIT_PER_MINUTE,
      DOCUMENT_CHAT_WINDOW_MS,
    );
    if (!rl.allowed) {
      const response = apiError("Too many requests. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    const removed = await detachDocument({
      userId,
      conversationId,
      documentId,
    });
    if (!removed) {
      // Missing row or foreign conversation → 404, no info leak.
      return apiError("Attachment not found", 404, {
        errorCode: "coach.fenced.attachmentNotFound",
      });
    }

    annotate({
      action: { name: "coach.attachments.removed" },
      meta: { conversationId, documentId },
    });

    const attachments = await loadConversationAttachmentDTOs(conversationId);
    // `fenced` stays true — the conversation is permanently fenced.
    return apiSuccess({ attachments, fenced: true });
  },
);
