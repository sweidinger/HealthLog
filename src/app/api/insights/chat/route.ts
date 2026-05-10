/**
 * v1.4.20 — POST /api/insights/chat
 *
 * Streaming chat endpoint for the AI Coach. Returns Server-Sent
 * Events: one `token` frame per chunk of the assistant reply, then a
 * single `provenance` frame describing what the assistant could see,
 * and a closing `done` frame carrying the persisted message ids.
 *
 * Behaviour:
 *   1. requireAuth() — cookie session OR bearer token (iOS app).
 *   2. Validate body with `coachChatRequestSchema`.
 *   3. enforceBudget() — 429 with `coach.budget.exceeded` when the
 *      user has already burned the day's token cap.
 *   4. detectRefusal() — pattern-based prompt-injection +
 *      off-topic guard. Refusal emits a single `token` frame with
 *      the localised refusal copy and a `done` frame; never hits a
 *      provider.
 *   5. Idempotency: only when `conversationId` is absent (= the user
 *      is creating a new conversation). withIdempotency() caches the
 *      streamed body so a retry under the same Idempotency-Key
 *      replays the original assistant message instead of double-
 *      creating the conversation.
 *   6. Provider chain — runRawCompletionWithFallback() walks the
 *      user's configured providers; on AllProvidersFailedError emit
 *      an `error` frame and persist nothing.
 *   7. Persist user message + assistant message (encrypted) and bump
 *      the day's CoachUsage token ledger.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { resolveProviderChain, resolveProvider } from "@/lib/ai/provider";
import type { CompletionResult } from "@/lib/ai/types";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";

import {
  coachChatRequestSchema,
  type CoachStreamEvent,
} from "@/lib/ai/coach/types";
import {
  appendMessage,
  createConversation,
  fetchConversationWithMessages,
  listConversations,
} from "@/lib/ai/coach/persistence";
import {
  buildDateKey,
  enforceBudget,
  recordSpend,
} from "@/lib/ai/coach/budget";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";

/**
 * Hard cap on total turns kept inside the per-call prompt window.
 * Older turns past this point are folded into a single synthetic
 * summary so cost stays bounded.
 */
const TURN_CAP = 20;
const RECENT_HISTORY = 18; // Last N turns kept verbatim before the new user message.

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function encodeFrame(event: CoachStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Split a full assistant reply into ~roughly-word-sized chunks so the
 * UI gets a "streaming" feel even when the underlying provider client
 * returned the body in one shot.
 */
function tokeniseForStreaming(content: string): string[] {
  if (!content) return [];
  // Split on whitespace boundaries while preserving the spaces — keeps
  // word boundaries intact and avoids the UI having to glue tokens.
  const matches = content.match(/\S+\s*/g);
  return matches ?? [content];
}

interface CoachTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Convert the persisted-message rows into the OpenAI-compatible
 * `{ role, content }` chat shape the provider clients expect.
 *
 * Also enforces the 20-turn cap: when the conversation history exceeds
 * `TURN_CAP`, the older half is folded into a single synthetic
 * "[summary]" user message so the prompt budget stays bounded. This is
 * best-effort — we don't pay for a separate provider call to summarise;
 * we just keep the last `RECENT_HISTORY` turns verbatim and prepend a
 * placeholder line that names the elided count.
 */
function buildHistoryWindow(turns: CoachTurn[]): CoachTurn[] {
  if (turns.length <= TURN_CAP) return turns;
  const elided = turns.length - RECENT_HISTORY;
  const recent = turns.slice(turns.length - RECENT_HISTORY);
  return [
    {
      role: "user",
      content: `[summary placeholder — ${elided} earlier turns elided to stay within the conversation budget]`,
    },
    ...recent,
  ];
}

async function handleChatRequest(request: NextRequest): Promise<Response> {
  const auth = await requireAuth();
  const userId = auth.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const parsed = coachChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    return NextResponse.json(
      { data: null, error: "coach.request.invalid" },
      { status: 422 },
    );
  }
  const { conversationId, message, locale: bodyLocale } = parsed.data;

  await enforceBudget(userId);

  const locale = await resolveServerLocale({
    request,
    override: bodyLocale,
    userLocale: auth.user.locale ?? null,
  });

  // ── Refusal short-circuit ────────────────────────────────────
  const refusal = detectRefusal({ message, locale });
  if (refusal.refuse && refusal.message) {
    annotate({
      action: { name: "insights.coach.refused" },
      meta: { reason: refusal.reason },
    });
    return streamRefusal({
      userId,
      conversationId,
      message,
      refusalText: refusal.message,
    });
  }

  // ── Conversation resolution ──────────────────────────────────
  let workingConversationId: string;
  let priorTurns: CoachTurn[] = [];

  if (conversationId) {
    const existing = await fetchConversationWithMessages(
      userId,
      conversationId,
    );
    if (!existing) {
      // 404, not 403 — never reveal cross-user existence
      throw new HttpError(404, "coach.conversation.notFound");
    }
    workingConversationId = existing.id;
    priorTurns = existing.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  } else {
    const created = await createConversation({ userId, title: message });
    workingConversationId = created.id;
  }

  // Persist the user's turn first so it's safely on disk regardless
  // of whether the provider call succeeds.
  await appendMessage({
    conversationId: workingConversationId,
    role: "user",
    content: message,
  });

  // Build the prompt: system + (optional) snapshot + recent history +
  // the new user message.
  const snapshot = await buildCoachSnapshot(userId);
  const systemPrompt = getCoachSystemPrompt(locale);
  const window = buildHistoryWindow([
    ...priorTurns,
    { role: "user", content: message },
  ]);
  const transcript = window
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");
  const userPrompt = `SNAPSHOT
${snapshot.snapshotJson || "(no metric data in this user's log yet)"}

CONVERSATION
${transcript}

Reply now as the assistant, in ${locale === "de" ? "German" : "English"}.`;

  // ── Provider chain ──────────────────────────────────────────
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      annotate({
        action: { name: "insights.coach.noProvider" },
      });
      return streamProviderError({
        conversationId: workingConversationId,
        snapshot: snapshot.provenance,
        code: "coach.provider.none",
      });
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  let result: CompletionResult;
  let workingProviderType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt,
        userPrompt,
        temperature: 0.4,
        maxTokens: 600,
      },
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      annotate({
        action: { name: "insights.coach.providerFailed" },
        meta: {
          attempts: err.attempts.length,
          firstStatus: err.attempts[0]?.httpStatus ?? null,
        },
      });
      return streamProviderError({
        conversationId: workingConversationId,
        snapshot: snapshot.provenance,
        code: "coach.provider.unavailable",
      });
    }
    throw err;
  }

  const replyText = (result.content ?? "").trim();
  if (!replyText) {
    return streamProviderError({
      conversationId: workingConversationId,
      snapshot: snapshot.provenance,
      code: "coach.provider.empty",
    });
  }

  // Persist the assistant message BEFORE we begin streaming; if the
  // client disconnects we still have the canonical row.
  const assistantMessage = await appendMessage({
    conversationId: workingConversationId,
    role: "assistant",
    content: replyText,
    metricSource: snapshot.provenance,
    providerType: workingProviderType,
    promptVersion: PROMPT_VERSION,
  });

  // Bump the day's spend ledger AFTER persistence so a retried request
  // doesn't double-count when the persistence layer rolled back.
  await recordSpend({
    userId,
    tokens: result.tokensUsed ?? 0,
    dateKey: buildDateKey(),
  });

  annotate({
    action: { name: "insights.coach.replied" },
    meta: {
      provider: workingProviderType,
      tokens: result.tokensUsed ?? null,
      promptVersion: PROMPT_VERSION,
      conversationId: workingConversationId,
      historyTurns: window.length,
    },
  });

  // ── Stream the body to the client ────────────────────────────
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        for (const tok of tokeniseForStreaming(replyText)) {
          controller.enqueue(encodeFrame({ type: "token", token: tok }));
        }
        controller.enqueue(
          encodeFrame({
            type: "provenance",
            metricSource: snapshot.provenance,
          }),
        );
        controller.enqueue(
          encodeFrame({
            type: "done",
            conversationId: workingConversationId,
            messageId: assistantMessage.id,
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Emit a refusal as a single `token` frame followed by `done`. No
 * provider call, no persisted assistant message — the user message is
 * still kept on disk so the rail shows the conversation history
 * accurately. The user message landing on disk is a deliberate choice;
 * the rail otherwise wouldn't show the user's attempt at all.
 */
async function streamRefusal(args: {
  userId: string;
  conversationId: string | undefined;
  message: string;
  refusalText: string;
}): Promise<Response> {
  let conversationId = args.conversationId;
  if (!conversationId) {
    const created = await createConversation({
      userId: args.userId,
      title: args.message,
    });
    conversationId = created.id;
  } else {
    const owned = await prisma.coachConversation.findFirst({
      where: { id: conversationId, userId: args.userId },
      select: { id: true },
    });
    if (!owned) {
      throw new HttpError(404, "coach.conversation.notFound");
    }
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
    metricSource: { windows: [], metrics: ["general"] },
    providerType: "refusal",
    promptVersion: PROMPT_VERSION,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        controller.enqueue(
          encodeFrame({ type: "token", token: args.refusalText }),
        );
        controller.enqueue(
          encodeFrame({
            type: "done",
            conversationId,
            messageId: refusalMessage.id,
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function streamProviderError(args: {
  conversationId: string;
  snapshot: ReturnType<typeof Object.assign>;
  code: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        controller.enqueue(
          encodeFrame({
            type: "error",
            code: args.code,
            message: args.code,
          }),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 503, headers: SSE_HEADERS });
}

const handler = apiHandler(async (request: NextRequest) => {
  // Idempotency wrap is applied only when the user is creating a new
  // conversation (the spec). For follow-up turns inside an existing
  // thread, retries SHOULD hit the route again — every turn is a real
  // server-side action, not a duplicate-prone POST.
  let cloneForCheck: NextRequest | undefined = undefined;
  let conversationId: string | undefined = undefined;
  try {
    cloneForCheck = request.clone() as NextRequest;
    const body = await cloneForCheck.json();
    if (typeof body?.conversationId === "string") {
      conversationId = body.conversationId;
    }
  } catch {
    // fall through; validation will surface the issue inside the
    // handler.
  }
  if (conversationId) {
    return handleChatRequest(request);
  }
  return withIdempotency(handleChatRequest)(request);
});

export const POST = handler;

/**
 * GET /api/insights/chat?cursor=<id>&limit=<n>
 *
 * Cursor-paginated list of the caller's conversations for the rail.
 * Default limit 20, hard cap 50. Cursor is the id of the last item
 * on the previous page; callers receive `{ nextCursor: null }` when
 * they have reached the end.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth();
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const page = await listConversations({
    userId: auth.user.id,
    cursor,
    limit: Number.isFinite(limit) ? (limit as number) : undefined,
  });

  annotate({
    action: { name: "insights.coach.list" },
    meta: { count: page.conversations.length },
  });

  return apiSuccess(page);
});

// Disable the static-page optimisation; we are always streaming.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
