/**
 * GET  /api/insights/chat/[id] — fetch one conversation with all
 *                                 messages decrypted on the fly.
 * DELETE /api/insights/chat/[id] — hard-delete the conversation +
 *                                  every message under it.
 *
 * Ownership: both verbs verify the conversation belongs to the
 * authenticated user. A foreign id maps to 404 (NOT 403) so the
 * existence channel never leaks across accounts.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

import {
  deleteConversation,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAuth();
  const { id } = await ctx.params;
  if (!id) return apiError("coach.conversation.notFound", 404);

  const detail = await fetchConversationWithMessages(auth.user.id, id);
  if (!detail) {
    return apiError("coach.conversation.notFound", 404);
  }

  annotate({
    action: { name: "insights.coach.fetch" },
    meta: { conversationId: id, messageCount: detail.messageCount },
  });

  return apiSuccess(detail);
});

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    if (!id) return apiError("coach.conversation.notFound", 404);

    const ok = await deleteConversation(auth.user.id, id);
    if (!ok) {
      return apiError("coach.conversation.notFound", 404);
    }

    annotate({
      action: { name: "insights.coach.delete" },
      meta: { conversationId: id },
    });

    return apiSuccess({ deleted: true });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
