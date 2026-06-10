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
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireAssistantSurface } from "@/lib/feature-flags";

import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { resolveProviderChain, resolveProvider } from "@/lib/ai/provider";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
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
import { enqueueCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-shared";
import {
  buildDateKey,
  enforceBudget,
  recordSpend,
} from "@/lib/ai/coach/budget";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { parseKeyValuesSentinel } from "@/lib/ai/coach/keyvalues";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { createSseStream } from "@/lib/sse/create-stream";

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

/**
 * v1.12.0 — yield control back to the event loop for one tick so the
 * stream controller flushes the just-enqueued frame before the next one
 * is produced. `setTimeout(0)` (rather than a bare `Promise.resolve()`
 * microtask) hands the turn back to the platform's stream pump so each
 * SSE frame lands in its own network chunk; a microtask would drain
 * before the runtime gets a chance to flush. The delay is intentionally
 * zero — we want incremental delivery, not an artificial typewriter
 * pause.
 */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
 * `TURN_CAP`, the older half is folded out of the verbatim window. v1.11.1 —
 * if a rolling summary of those elided turns is on file
 * (`CoachConversation.summaryEncrypted`, refreshed off-budget by the
 * coach-memory-refresh worker) it is prepended so the Coach keeps memory of
 * the older conversation; otherwise we fall back to a placeholder that just
 * names the elided count (the pre-v1.11.1 behaviour). The summary is read
 * stale-while-revalidate — the current turn uses whatever is on disk, the
 * enqueued refresh makes the next long turn fresh.
 */
function buildHistoryWindow(
  turns: CoachTurn[],
  summary: string | null,
): CoachTurn[] {
  if (turns.length <= TURN_CAP) return turns;
  const elided = turns.length - RECENT_HISTORY;
  const recent = turns.slice(turns.length - RECENT_HISTORY);
  const memo = summary
    ? `[earlier conversation summary] ${summary}`
    : `[summary placeholder — ${elided} earlier turns elided to stay within the conversation budget]`;
  return [{ role: "user", content: memo }, ...recent];
}

async function handleChatRequest(request: NextRequest): Promise<Response> {
  const auth = await requireAuth();
  // v1.4.31 — operator can disable the Coach surface app-wide.
  // Throws AssistantDisabledError → apiHandler returns 403 +
  // `errorCode: "assistant.disabled.coach"` per the iOS contract.
  await requireAssistantSurface("coach");
  const userId = auth.user.id;

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      throw new HttpError(413, `Request body exceeds ${64 * 1024} bytes`);
    }
    body = JSON.parse(raw);
  } catch (err) {
    if (err instanceof HttpError) throw err;
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
  const { conversationId, message, locale: bodyLocale, scope } = parsed.data;

  // Per-user request-rate ceiling layered in front of the daily budget
  // gate. The budget catches the cost dimension; this catches the
  // request-rate dimension (a tight loop or a stolen session can burn
  // the budget in seconds while pinning Prisma + provider slots before
  // the budget arithmetic catches up). 20 / minute is well outside any
  // realistic interactive use — a human can't type that fast, the iOS
  // client paces from user gestures.
  const rl = await checkRateLimit(`coach-chat:${userId}`, 20, 60 * 1000);
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.coach.rate-limited" },
      meta: { userId, resetAt: rl.resetAt },
    });
    return apiError("Too many Coach requests, please wait a moment", 429);
  }

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
  // v1.11.1 — rolling summary of the elided older turns, read stale-while-
  // revalidate; null for a fresh conversation or when none is on file.
  let priorSummary: string | null = null;

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
    priorSummary = existing.summary ?? null;
    priorTurns = existing.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // v1.4.43 W13 M-3 — replay-injection guard. `detectRefusal` runs
    // only on the inbound `message` per turn, so an injection that
    // slipped past the regex bank on a previous turn would re-enter
    // the prompt every reply. Re-run the detector against every
    // user-turn re-loaded from DB; on a hit, short-circuit the SSE
    // with a refusal AND drop an `insights.coach.replay_injection`
    // row so the failure case is observable. The audit row carries
    // the conversation id (server-owned), the turn index (no PII)
    // and the matched reason — never the message content. v1.4.43
    // W10 simplifier-L-2 — action name follows the `<surface>.<verb>`
    // convention (no `audit.` prefix; no `.replay-injection` dash).
    for (let i = 0; i < priorTurns.length; i++) {
      const turn = priorTurns[i];
      if (turn.role !== "user") continue;
      const replayed = detectRefusal({ message: turn.content, locale });
      if (!replayed.refuse) continue;
      annotate({
        action: { name: "insights.coach.replay_injection" },
        meta: { reason: replayed.reason, turnIndex: i },
      });
      await auditLog("insights.coach.replay_injection", {
        userId,
        details: {
          conversationId: existing.id,
          turnIndex: i,
          reason: replayed.reason,
        },
      });
      return streamRefusal({
        userId,
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
  // the new user message. v1.4.23 H4 — fold per-user prefs into the
  // system-prompt prefix; the snapshot builder reads the same prefs
  // separately so excluded metrics never even leave the DB.
  //
  // v1.4.25 W5 — `coachPrefs.defaultWindow` is the user's saved
  // analysis-window preference. Merge it into the snapshot scope when
  // the client didn't supply a per-conversation override; the override
  // (header pill / sources rail) always wins. Keep the merge cheap so
  // we don't accidentally widen narrow per-call scopes.
  const prefsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true },
  });
  const coachPrefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  const effectiveScope =
    scope?.window === undefined && coachPrefs.defaultWindow
      ? { ...(scope ?? {}), window: coachPrefs.defaultWindow }
      : scope;
  const snapshot = await buildCoachSnapshot(userId, effectiveScope);
  const systemPrompt = getCoachSystemPrompt(locale, coachPrefs);
  const allTurns: CoachTurn[] = [
    ...priorTurns,
    { role: "user", content: message },
  ];
  const window = buildHistoryWindow(allTurns, priorSummary);
  // v1.11.1 — once a conversation grows past the history cap, refresh the
  // rolling summary + extract durable facts off the request path. Fire-and-
  // forget: this turn uses whatever summary is already on disk; the refresh
  // makes the next long turn fresh. No-ops without an embedded worker.
  if (allTurns.length > TURN_CAP) {
    void enqueueCoachMemoryRefresh({
      conversationId: workingConversationId,
      userId,
      // Coach memory prose is composed in de/en only (the snapshot's
      // coachLocale); collapse the wider UI locale union here.
      locale: locale === "en" ? "en" : "de",
    });
  }
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
      return streamProviderError({ code: "coach.provider.none" });
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  // v1.12.1 — consent gate before any server-managed external egress. When
  // the chain could egress via the operator's global key, require an active
  // `ai_coach` (or master `ai_full`) receipt. BYOK / local / ChatGPT-OAuth
  // chains are the user's own egress and stay ungated. Throws
  // ConsentRequiredError → apiHandler returns 403 + `consent.ai.required`.
  await assertConsentForChain({ userId, chain, surface: "coach" });

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
          credentialExpired: err.primaryCredentialExpired,
        },
      });
      // v1.11.0 W1 — when the user's PRIMARY provider failed with an
      // auth-class status (401/403), the credential is dead, not the
      // service. Surface a distinct `credential_expired` frame so the
      // drawer can deep-link the user to reconnect rather than telling
      // them to "try again later" — the gap that let an expired codex
      // token silently kill all generation.
      if (err.primaryCredentialExpired) {
        return streamProviderError({
          code: "coach.provider.credential_expired",
        });
      }
      // v1.4.25 W5 — distinguish provider rate-limit (every attempt
      // landed on 429) from generic unavailability. The drawer's
      // error-decoder surfaces the rate-limit copy with a warning
      // toast instead of the generic provider-down message, so the
      // user understands the limit is transient.
      const allRateLimited =
        err.attempts.length > 0 &&
        err.attempts.every((a) => a.httpStatus === 429);
      return streamProviderError({
        code: allRateLimited
          ? "coach.provider.rate_limited"
          : "coach.provider.unavailable",
      });
    }
    throw err;
  }

  const rawReply = (result.content ?? "").trim();
  if (!rawReply) {
    return streamProviderError({ code: "coach.provider.empty" });
  }

  // v1.4.22 — strip the optional `---KEYVALUES---` … `---END---`
  // sentinel out of the prose. The stripped prose is what we stream
  // to the client and persist; the parsed entries enrich the
  // provenance envelope so the UI can render the collapsible
  // "Worauf bezieht sich das?" disclosure.
  const sentinel = parseKeyValuesSentinel(rawReply);
  const proseAfterStrip = sentinel.prose.trim();
  // v1.4.22 W5 reconcile (Code-H1) — when the model emits a
  // sentinel-only / malformed reply, `sentinel.prose` is empty after
  // stripping. The previous fallback `sentinel.prose.trim() || rawReply`
  // surfaced raw `---KEYVALUES---` markers to the user. The empty-prose
  // condition signals an unusable provider response: short-circuit to
  // the structured `coach.provider.empty` error frame instead of
  // streaming the raw sentinel body.
  if (!proseAfterStrip) {
    annotate({
      action: { name: "coach.keyvalues.parse_failed" },
      meta: {
        kept: sentinel.keyValues.length,
        reason: "empty_prose_after_strip",
        promptVersion: PROMPT_VERSION,
      },
    });
    return streamProviderError({ code: "coach.provider.empty" });
  }
  const replyText = proseAfterStrip;
  const enrichedProvenance =
    sentinel.keyValues.length > 0
      ? { ...snapshot.provenance, keyValues: sentinel.keyValues }
      : snapshot.provenance;
  if (sentinel.malformed) {
    // Graceful degrade: log so ops can spot a provider whose
    // sentinel format has drifted, but pass the prose through
    // unchanged. v1.4.23 H1 — split the annotation:
    //   - parse_partial: at least one row parsed AND at least one
    //     row failed (mixed-format drift on a single reply)
    //   - parse_failed: the whole block was unusable
    // Both annotations carry the per-line `reasons` array so an ops
    // dashboard can attribute the failure cause without re-running
    // the parser.
    const reasons = sentinel.malformedEntries.map((entry) => entry.reason);
    const annotationName =
      sentinel.keyValues.length > 0 && sentinel.malformedEntries.length > 0
        ? "coach.keyvalues.parse_partial"
        : "coach.keyvalues.parse_failed";
    annotate({
      action: { name: annotationName },
      meta: {
        kept: sentinel.keyValues.length,
        malformedCount: sentinel.malformedEntries.length,
        reasons,
        promptVersion: PROMPT_VERSION,
      },
    });
  }

  // Persist the assistant message BEFORE we begin streaming; if the
  // client disconnects we still have the canonical row.
  const assistantMessage = await appendMessage({
    conversationId: workingConversationId,
    role: "assistant",
    content: replyText,
    metricSource: enrichedProvenance,
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
      // v1.7.0 — count of provenance metrics the snapshot surfaced
      // this turn (a proxy for cluster breadth) so the dashboards can
      // correlate reply shape with cluster activation.
      clusterCount: snapshot.provenance.metrics.length,
    },
  });

  // ── Stream the body to the client ────────────────────────────
  // v1.12.0 — yield to the event loop between token frames so each one
  // flushes as its own network chunk. The provider clients return the
  // full reply in one shot; without the yield the whole tokenised body
  // was enqueued synchronously inside `start()` and the runtime
  // coalesced every frame into a single read, so the client painted the
  // answer all at once despite the per-token render path in `use-coach`.
  // A zero-delay yield is enough to land each frame on its own tick —
  // the visible cadence reads ChatGPT/Claude-style without a contrived
  // sleep. The refusal + error paths stay single-frame (nothing to
  // pace).
  const stream = createSseStream(async (controller) => {
    for (const tok of tokeniseForStreaming(replyText)) {
      controller.enqueue(encodeFrame({ type: "token", token: tok }));
      await flushTick();
    }
    controller.enqueue(
      encodeFrame({
        type: "provenance",
        metricSource: enrichedProvenance,
      }),
    );
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId: workingConversationId,
        messageId: assistantMessage.id,
      }),
    );
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

  const stream = createSseStream((controller) => {
    controller.enqueue(encodeFrame({ type: "token", token: args.refusalText }));
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId,
        messageId: refusalMessage.id,
      }),
    );
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function streamProviderError(args: { code: string }): Response {
  const stream = createSseStream((controller) => {
    controller.enqueue(
      encodeFrame({
        type: "error",
        code: args.code,
        message: args.code,
      }),
    );
  });
  // Status 200 so the streaming client reads the SSE body and parses
  // the structured `error` frame (HTTP-status branches drop the
  // structured code on the floor).
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// Idempotency is intentionally NOT applied to this SSE-streaming route.
// `withIdempotency()` caches the response body via `cloned.text()` and
// replays it through `NextResponse.json(JSON.parse(...))` — that path
// turns an SSE wire format (`data: …\n\n` frames) into a `null` body
// because the cached text isn't JSON. The PWA never sets
// `Idempotency-Key` here so the bug is invisible today, but the iOS
// client does. Dedup still holds: a duplicate first-turn POST creates
// a second conversation row (cheap), and follow-up turns are gated by
// the conversationId existence check + 20-turn cap.
export const POST = apiHandler(handleChatRequest);

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
  // v1.4.31 — same gate as the SSE POST. Hiding the rail when
  // the operator has disabled Coach matches the FAB suppression
  // on the client.
  await requireAssistantSurface("coach");
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
