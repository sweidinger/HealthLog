/**
 * v1.27.33 (Document vault P4) — chat about ONE stored document.
 *
 * POST streams a grounded prose reply about a single document's text as
 * Server-Sent Events; GET reads the document's chat history. The conversation
 * persists (encrypted) as a `CoachConversation` with `documentId` set, reusing
 * the entire Coach message store, so re-opening the document shows the thread.
 *
 * SECURITY MODEL (the heart of this feature — untrusted document text enters an
 * LLM prompt):
 *   - NO TOOLS. A single completion per turn, never the Coach tool loop. There
 *     is nothing an injected instruction could DO — no write, no other resource.
 *   - NO HEALTH SNAPSHOT (research D3). The ONLY context is this one document's
 *     text; the user's health record is never injected.
 *   - PROMPT-INJECTION FENCING. The document text is fenced as DATA via
 *     `fenceDocument` (marker pair + marker-scrubbing) inside the system prompt,
 *     which states the fenced content is a document to answer questions about,
 *     not instructions to follow. `detectRefusal` guards the inbound message and
 *     REPLAYS over every prior user turn on reload; `screenCoachReply` guards the
 *     outbound reply (dose-prescription / fabricated-risk-score).
 *   - NUMERIC GROUNDING. `findUnverifiedCoachNumbers`, pointed at the document's
 *     own numbers as the authoritative set, strips any figure the model invents.
 *   - CONSENT + BUDGET + RATE. `assertDocumentEgressConsent` (the document is
 *     sent to the provider) on the document-ordered pick (local-first, codex
 *     last), the shared AI budget ledger, and a per-user `document-chat` rate
 *     bucket. Answers render as PLAIN React text on the client (no markdown lib).
 *   - INDEXED DOCUMENTS ONLY. The chat is available only for a document that has
 *     been content-indexed (its text is the grounding); 422 otherwise.
 */
import { type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { createSseStream } from "@/lib/sse/create-stream";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
import {
  AllProvidersFailedError,
  runStreamingRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { singleUserTurn } from "@/lib/ai/types";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import {
  screenCoachReply,
  coachOutboundFallback,
} from "@/lib/ai/coach/outbound-guard";
import {
  findUnverifiedCoachNumbers,
  stripUnverifiedNumbers,
} from "@/lib/ai/coach/coach-prose-grounding";
import {
  appendMessage,
  createConversation,
  fetchConversationWithMessages,
  listConversations,
} from "@/lib/ai/coach/persistence";
import type { CoachStreamEvent } from "@/lib/ai/coach/types";

import {
  DOCUMENT_CHAT_BUCKET,
  DOCUMENT_CHAT_LIMIT_PER_MINUTE,
  DOCUMENT_CHAT_WINDOW_MS,
  loadOwnedDocument,
} from "@/lib/documents/ai-route-support";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { buildDocumentChatSystemPrompt } from "@/lib/documents/document-chat-prompt";
import { resolveDocumentTextProvider } from "@/lib/documents/provider-order";
import {
  documentChatHistoryQuerySchema,
  documentChatRequestSchema,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Keepalive comment frame so a reverse proxy never idle-drops a slow backend. */
const HEARTBEAT_MS = 12_000;
const HEARTBEAT_FRAME = new TextEncoder().encode(": ka\n\n");

/** Prior turns kept verbatim in the per-call window — document chats are short. */
const HISTORY_TURN_CAP = 20;

function encodeFrame(event: CoachStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** Split a full reply into ~word-sized chunks for a streaming feel. */
function tokeniseForStreaming(content: string): string[] {
  if (!content) return [];
  const matches = content.match(/\S+\s*/g);
  return matches ?? [content];
}

/** Yield to the event loop so each SSE frame flushes as its own chunk. */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A standalone SSE stream carrying a single structured error frame (HTTP 200). */
function streamError(code: string): Response {
  const stream = createSseStream((controller) => {
    controller.enqueue(encodeFrame({ type: "error", code, message: code }));
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

// ─── POST — send a turn, stream the reply ───────────────────────────────────

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(userId, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    // The chat is available ONLY for a content-indexed document — its text is
    // the sole grounding. Prefer the verbatim capture; fall back to normalised.
    const context = await loadDocumentChatText(userId, id);
    if (!context) {
      return apiError("This document has not been indexed for chat yet.", 422, {
        errorCode: "documents.inbound.notIndexed",
      });
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = documentChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid document chat request", 422, {
        errorCode: "documents.chat.invalid",
      });
    }
    const { conversationId, message, locale: bodyLocale } = parsed.data;

    // Per-user request-rate ceiling in front of the daily budget gate.
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

    const locale = await resolveServerLocale({
      request,
      override: bodyLocale,
      userLocale: user.locale ?? null,
    });
    const contractLocale = locale === "de" ? "de" : "en";

    // ── Inbound refusal / injection guard ──────────────────────────────
    const refusal = detectRefusal({ message, locale, defaultAllow: true });
    if (refusal.refuse && refusal.message) {
      annotate({
        action: { name: "documents.chat.refused" },
        meta: { reason: refusal.reason },
      });
      return streamRefusal({
        userId,
        documentId: id,
        conversationId,
        message,
        refusalText: refusal.message,
      });
    }

    // ── Conversation resolution (document-scoped) ──────────────────────
    let workingConversationId: string;
    let priorTurns: Turn[] = [];
    if (conversationId) {
      const existing = await fetchConversationWithMessages(
        userId,
        conversationId,
        { documentId: id },
      );
      if (!existing) {
        // 404, not 403 — never reveal cross-user / cross-document existence.
        throw new HttpError(404, "documents.chat.conversationNotFound");
      }
      workingConversationId = existing.id;
      priorTurns = existing.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Replay-injection guard: an injection that slipped past the regex bank
      // on an earlier turn would re-enter the prompt every reply. Re-run the
      // detector over every prior user turn; on a hit, refuse.
      for (let i = 0; i < priorTurns.length; i++) {
        const turn = priorTurns[i];
        if (turn.role !== "user") continue;
        const replayed = detectRefusal({ message: turn.content, locale });
        if (!replayed.refuse) continue;
        annotate({
          action: { name: "documents.chat.replay_injection" },
          meta: { reason: replayed.reason, turnIndex: i },
        });
        await auditLog("documents.chat.replay_injection", {
          userId,
          details: {
            conversationId: existing.id,
            documentId: id,
            turnIndex: i,
            reason: replayed.reason,
          },
        });
        return streamRefusal({
          userId,
          documentId: id,
          conversationId: existing.id,
          message,
          refusalText:
            replayed.message ??
            (locale === "de"
              ? "Eine frühere Nachricht in dieser Unterhaltung enthält Anweisungen, die meine Vorgaben überschreiben sollen. Beginne bitte eine neue Unterhaltung."
              : "An earlier message in this conversation contains wording that overrides my instructions. Please start a new conversation."),
        });
      }
    } else {
      const created = await createConversation({
        userId,
        title: message,
        documentId: id,
      });
      workingConversationId = created.id;
    }

    // ── Provider resolution (document order: local-first, codex last) ──
    // No vision needed — the chat grounds on the STORED TEXT, not the image, so
    // ANY configured provider can chat. A single pick (no runner cascade) so the
    // exact egress equals the picked provider that `assertDocumentEgressConsent`
    // gates.
    const { pick } = await resolveDocumentTextProvider(userId);
    if (!pick) {
      annotate({ action: { name: "documents.chat.noProvider" } });
      return streamError("documents.chat.provider.none");
    }
    // Consent for the document leaving the machine to a third-party AI. A local
    // pick stays ungated; any external pick needs an active receipt (403).
    await assertDocumentEgressConsent({
      userId,
      providerType: pick.providerType,
      surface: "insights",
    });

    // Persist the user's turn first so it's on disk regardless of the outcome.
    await appendMessage({
      conversationId: workingConversationId,
      role: "user",
      content: message,
    });

    // ── Budget reservation (atomic, before the provider call) ──────────
    const dateKey = buildDateKey();
    const reservation = await reserveBudget(
      userId,
      AI_BUDGETS.documentChat.maxTokens,
      dateKey,
      resolveDailyCap([{ providerType: pick.entry.providerType }]),
    );
    if (!reservation.allowed) {
      annotate({ action: { name: "documents.chat.budget.exceeded" } });
      return streamError("documents.chat.budget.exceeded");
    }

    // ── Build the lean prompt: system (persona + safety + FENCED document,
    // NO health snapshot) + the conversation transcript. ──────────────
    const systemPrompt = buildDocumentChatSystemPrompt(
      contractLocale,
      context.text,
    );
    const window: Turn[] = [
      ...priorTurns.slice(-HISTORY_TURN_CAP),
      { role: "user", content: message },
    ];
    const transcript = window
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join("\n\n");
    const userPrompt = `CONVERSATION
${transcript}

Reply now as the assistant, grounded ONLY in the document above, in ${
      contractLocale === "de" ? "German" : "English"
    }.`;

    type Outcome =
      | {
          ok: true;
          replyText: string;
          messageId: string;
          totalTokens: number;
          model: string | null;
        }
      | { ok: false; code: string };

    async function produceReply(): Promise<Outcome> {
      let result;
      try {
        const fallback = await runStreamingRawCompletionWithFallback({
          userId,
          // Single-provider — the document-ordered pick, no cascade.
          providers: [pick!.entry],
          onDelta: () => {},
          params: singleUserTurn({
            system: systemPrompt,
            user: userPrompt,
            temperature: AI_BUDGETS.documentChat.temperature,
            maxTokens: AI_BUDGETS.documentChat.maxTokens,
            signal: request.signal,
          }),
        });
        result = fallback.result;
      } catch (err) {
        // Provider failed — no tokens billed; refund the full reservation.
        await reconcileSpend(userId, reservation.reserved, 0, dateKey).catch(
          () => {},
        );
        if (err instanceof AllProvidersFailedError) {
          const allRateLimited =
            err.attempts.length > 0 &&
            err.attempts.every((a) => a.httpStatus === 429);
          annotate({
            action: { name: "documents.chat.providerFailed" },
            meta: {
              attempts: err.attempts.length,
              credentialExpired: err.primaryCredentialExpired,
            },
          });
          if (err.primaryCredentialExpired) {
            return { ok: false, code: "documents.chat.provider.credential_expired" };
          }
          return {
            ok: false,
            code: allRateLimited
              ? "documents.chat.provider.rate_limited"
              : "documents.chat.provider.unavailable",
          };
        }
        annotate({
          action: { name: "documents.chat.providerFailed" },
          meta: { attempts: 1, unwrapped: true },
        });
        return { ok: false, code: "documents.chat.provider.unavailable" };
      }

      const totalTokens = result.tokensUsed ?? 0;
      const cachedTokens = result.cachedInputTokens ?? 0;
      // Tokens were billed regardless of reply quality — reconcile now.
      await reconcileSpend(
        userId,
        reservation.reserved,
        totalTokens,
        dateKey,
        cachedTokens,
      ).catch(() => {});

      let replyText = (result.content ?? "").trim();
      if (!replyText) return { ok: false, code: "documents.chat.provider.empty" };

      // ── Outbound safety screen (dose-prescription / fabricated risk) ──
      const outbound = screenCoachReply(replyText);
      if (outbound.block && outbound.reason) {
        replyText = coachOutboundFallback(outbound.reason, locale);
        annotate({
          action: { name: "documents.chat.outbound_blocked" },
          meta: { reason: outbound.reason },
        });
        await auditLog("documents.chat.outbound_blocked", {
          userId,
          details: { conversationId: workingConversationId, reason: outbound.reason },
        });
      }

      // ── Numeric grounding — authoritative set = the DOCUMENT's numbers ──
      // A blocked turn already carries canned fallback prose, so skip it.
      if (!outbound.block) {
        const unverified = findUnverifiedCoachNumbers(replyText, [context!.text]);
        if (unverified.length > 0) {
          const { prose, stripped } = stripUnverifiedNumbers(replyText, unverified);
          replyText = prose;
          annotate({
            action: { name: "documents.chat.number_unverified" },
            meta: {
              flagged: unverified.length,
              stripped,
              tokens: unverified.slice(0, 6).map((u) => u.source),
            },
          });
        }
      }

      // Persist the assistant turn BEFORE streaming; a disconnect still leaves
      // the canonical row on disk.
      const assistant = await appendMessage({
        conversationId: workingConversationId,
        role: "assistant",
        content: replyText,
        providerType: pick!.providerType,
        tokensUsed: totalTokens || null,
        model: result.model ?? null,
      });

      annotate({
        action: { name: "documents.chat.replied" },
        meta: {
          provider: pick!.providerType,
          tokens: totalTokens,
          conversationId: workingConversationId,
          documentId: id,
          historyTurns: window.length,
          textSource: context!.source,
        },
      });

      return {
        ok: true,
        replyText,
        messageId: assistant.id,
        totalTokens,
        model: result.model ?? null,
      };
    }

    // ── Stream the body ────────────────────────────────────────────────
    const stream = createSseStream(async (controller) => {
      const heartbeat = setInterval(() => {
        controller.enqueue(HEARTBEAT_FRAME);
      }, HEARTBEAT_MS);

      let outcome: Outcome;
      try {
        outcome = await produceReply();
      } catch (err) {
        clearInterval(heartbeat);
        annotate({
          action: { name: "documents.chat.streamError" },
          meta: { message: err instanceof Error ? err.name : "unknown" },
        });
        if (!controller.signal.aborted) {
          controller.enqueue(
            encodeFrame({
              type: "error",
              code: "documents.chat.provider.unavailable",
              message: "documents.chat.provider.unavailable",
            }),
          );
        }
        return;
      }
      clearInterval(heartbeat);

      if (!outcome.ok) {
        if (!controller.signal.aborted) {
          controller.enqueue(
            encodeFrame({ type: "error", code: outcome.code, message: outcome.code }),
          );
        }
        return;
      }

      for (const tok of tokeniseForStreaming(outcome.replyText)) {
        if (controller.signal.aborted) return;
        controller.enqueue(encodeFrame({ type: "token", token: tok }));
        await flushTick();
      }
      if (controller.signal.aborted) return;
      controller.enqueue(
        encodeFrame({
          type: "done",
          conversationId: workingConversationId,
          messageId: outcome.messageId,
          usage: { totalTokens: outcome.totalTokens || null, model: outcome.model },
        }),
      );
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  },
);

/**
 * Emit a refusal as a single `token` frame + `done`. No provider call, no
 * persisted assistant message — the user message is kept so the rail shows the
 * attempt. Mirrors the Coach's `streamRefusal`, document-scoped.
 */
async function streamRefusal(args: {
  userId: string;
  documentId: string;
  conversationId: string | undefined;
  message: string;
  refusalText: string;
}): Promise<Response> {
  let conversationId = args.conversationId;
  if (!conversationId) {
    const created = await createConversation({
      userId: args.userId,
      title: args.message,
      documentId: args.documentId,
    });
    conversationId = created.id;
  } else {
    const owned = await fetchConversationWithMessages(
      args.userId,
      conversationId,
      { documentId: args.documentId },
    );
    if (!owned) throw new HttpError(404, "documents.chat.conversationNotFound");
  }

  await appendMessage({
    conversationId,
    role: "user",
    content: args.message,
  });
  const refusalMessage = await appendMessage({
    conversationId,
    role: "assistant",
    content: args.refusalText,
    providerType: "refusal",
  });

  const stream = createSseStream((controller) => {
    controller.enqueue(encodeFrame({ type: "token", token: args.refusalText }));
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId: conversationId!,
        messageId: refusalMessage.id,
      }),
    );
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// ─── GET — the document's chat history ──────────────────────────────────────

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const userId = user.id;

    const gate = await requireModuleEnabled(userId, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(userId, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    const url = new URL(request.url);
    const parsed = documentChatHistoryQuerySchema.safeParse({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return apiError("Invalid chat history query", 422, {
        errorCode: "documents.chat.invalid",
      });
    }

    // With a conversationId → that one thread's messages (document-scoped).
    if (parsed.data.conversationId) {
      const detail = await fetchConversationWithMessages(
        userId,
        parsed.data.conversationId,
        { documentId: id },
      );
      if (!detail) {
        return apiError("Conversation not found", 404, {
          errorCode: "documents.chat.conversationNotFound",
        });
      }
      annotate({
        action: { name: "documents.chat.fetch" },
        meta: { documentId: id, messageCount: detail.messageCount },
      });
      return apiSuccess(detail);
    }

    // Otherwise → the paginated list of this document's chat threads.
    const page = await listConversations({
      userId,
      documentId: id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    annotate({
      action: { name: "documents.chat.list" },
      meta: { documentId: id, count: page.conversations.length },
    });
    return apiSuccess(page);
  },
);
