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
import { requireModuleEnabled } from "@/lib/modules/gate";

import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { resolveProviderChain, resolveProvider } from "@/lib/ai/provider";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import { singleUserTurn, type CompletionResult } from "@/lib/ai/types";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

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
import { storeDeterministicFacts } from "@/lib/ai/coach/facts";
import {
  buildDateKey,
  reserveBudget,
  reconcileSpend,
} from "@/lib/ai/coach/budget";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import {
  screenCoachReply,
  coachOutboundFallback,
} from "@/lib/ai/coach/outbound-guard";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import { getSelfContextTextForUser } from "@/lib/ai/coach/about-me";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import {
  COACH_TOOL_DEFS,
  buildCoachDataInventory,
  renderDataInventory,
  buildToolModeAddendum,
  runCoachToolLoop,
  MAX_ROUNDS,
  type CoachToolTrace,
} from "@/lib/ai/coach/tools";
import type { AiMessage } from "@/lib/ai/types";
import { parseKeyValuesSentinel } from "@/lib/ai/coach/keyvalues";
import { parseSuggestReminder } from "@/lib/ai/coach/suggest-reminder";
import { gateSuggestion } from "@/lib/ai/coach/suggest-gate";
import {
  parseCoachPrefs,
  DEFAULT_REMINDER_SUGGESTION_PREFS,
} from "@/lib/validations/coach-prefs";
import type { CoachSuggestion } from "@/lib/ai/coach/types";
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
  // v1.18.0 — two-layer module gate (operator availability + per-user
  // disableCoach) on top of the legacy assistant flag. 403 module.disabled.
  const gate = await requireModuleEnabled(auth.user.id, "coach");
  if (!gate.enabled) return gate.response;
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
  const {
    conversationId,
    message,
    locale: bodyLocale,
    scope,
    guidedQuestion,
  } = parsed.data;

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

  // v1.18.7 (SENIOR-DEV HIGH) — the daily token cap is enforced atomically
  // by reserving budget BEFORE the provider call (see the reservation right
  // before `runRawCompletionWithFallback`), not by a read-then-write here.
  // The old read-before-call gate let concurrent requests all pass the cap.

  const locale = await resolveServerLocale({
    request,
    override: bodyLocale,
    userLocale: auth.user.locale ?? null,
  });

  // ── Refusal short-circuit ────────────────────────────────────
  // v1.16.6 — the guided-flow question rides the prompt too, so it
  // runs through the same regex bank as the message. The questions
  // are server-derived in the honest case; this guards the dishonest
  // one (a crafted client using the field as an unchecked channel).
  const refusal = detectRefusal({
    message: guidedQuestion ? `${guidedQuestion}\n${message}` : message,
    locale,
  });
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
  // v1.15.20 — the user-authored "about me" self-description (Settings →
  // AI) rides the system prompt as a delimited, user-provided context
  // block. Fail-open: a missing / undecryptable text yields null and the
  // prompt is byte-identical to the pre-feature one.
  // v1.16.0 — composed self-context: structured questionnaire fields
  // plus age/gender merged in from the User profile.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  const systemPrompt = getCoachSystemPrompt(locale, coachPrefs, aboutMe);
  const allTurns: CoachTurn[] = [
    ...priorTurns,
    { role: "user", content: message },
  ];
  const window = buildHistoryWindow(allTurns, priorSummary);
  // v1.11.1 — once a conversation grows past the history cap, refresh the
  // rolling summary + extract durable facts off the request path. Fire-and-
  // forget: this turn uses whatever summary is already on disk; the refresh
  // makes the next long turn fresh. No-ops without an embedded worker.
  // v1.16.1 — always-remember categories (allergies, intolerances, explicit
  // self-reported diagnoses) must not wait for the >TURN_CAP memory refresh:
  // a health-critical statement in the second message of a short chat used
  // to never reach the fact store. The deterministic pattern pass is
  // provider-free and deduped, so it fires on every user turn.
  void storeDeterministicFacts({
    conversationId: workingConversationId,
    userId,
    message,
    locale,
  }).catch(() => {
    // Fact capture must never break the chat turn; the >TURN_CAP LLM
    // extraction remains as the catch-all on long conversations.
  });
  if (allTurns.length > TURN_CAP) {
    void enqueueCoachMemoryRefresh({
      conversationId: workingConversationId,
      userId,
      // Coach memory prose is composed in de/en only (the snapshot's
      // coachLocale); collapse the wider UI locale union here.
      locale: locale === "en" ? "en" : "de",
    });
  }
  // v1.19.1 (C4) — token efficiency. The full SNAPSHOT (now incl. labs,
  // illness, cycle, every cluster + the reference-grounding block) is the
  // single biggest cost in a Coach turn — typing one word used to re-ship the
  // whole ~15k-token block. The grounding only needs to enter the prompt ONCE
  // per conversation: the model's first reply is composed against it and that
  // reply rides the conversation transcript on every following turn, so the
  // figures stay in-context without re-paying for them. We therefore include
  // the full block only when:
  //   - this is the first turn (no prior turns on disk), OR
  //   - the history window has begun eliding turns (`allTurns.length > TURN_CAP`)
  //     — once the oldest turns are folded into the rolling summary the original
  //     snapshot may have scrolled out of the verbatim window, so we re-ground.
  // On the cheap path (a follow-up inside the verbatim window) we send a short
  // pointer instead of the figures, preserving grounding + cross-metric
  // correlation quality at a fraction of the wire cost.
  const isFirstTurn = priorTurns.length === 0;
  const historyEliding = allTurns.length > TURN_CAP;
  const includeFullSnapshot = isFirstTurn || historyEliding;
  const transcript = window
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");
  // v1.16.6 — guided clarifying-questions flow: the question the user
  // is answering exists only as a client-side bubble, so hand it to
  // the model as delimited context. The reaction should read as a
  // natural reply to the answer, not as a re-ask.
  const guidedBlock = guidedQuestion
    ? `\nGUIDED QUESTION (user-provided context)
The user's message answers this clarifying question from their self-context questionnaire:
"""${guidedQuestion}"""
React briefly and personally to the answer; do not repeat the question and do not ask it again.
`
    : "";

  // ── Provider chain ──────────────────────────────────────────
  // v1.20.0 (F1) — resolved BEFORE the prompt is built so we know whether to
  // run the tool-based retrieval path or the legacy snapshot-stuffing path.
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

  // v1.20.0 (F1) — tool mode is on only when EVERY provider in the chain
  // supports tool-calling, so whichever hop the fallback runner lands on can
  // still serve tools. A chain that includes a no-tools provider (local /
  // Ollama) falls back to the legacy snapshot-stuffing path verbatim, exactly
  // as before — the snapshot builder stays alive as the no-tools floor.
  const toolMode = chain.every((c) => c.instance.supportsTools !== false);

  // v1.18.6 (W7) — citation-aware reference-range grounding for the metrics
  // present in this snapshot. Deterministic + brand-free; framed as general
  // guidance, never a diagnosis. Appended after the SNAPSHOT so it is fully
  // inspectable and the model reads the published population bands + the
  // user's placement. Omitted entirely when no present metric is covered by
  // the reference backbone (the builder returns null).
  const groundingBlock =
    includeFullSnapshot && snapshot.referenceGrounding
      ? `\n${snapshot.referenceGrounding}\n`
      : "";
  // v1.19.1 (C4) — the SNAPSHOT block is the expensive prefix. On the first
  // turn (or after the history window starts eliding) we ship the full figures;
  // on a cheap follow-up we ship a one-line pointer back to the snapshot the
  // model already received earlier in this same conversation, so it keeps
  // grounding its numbers in that data without us re-paying for the block.
  const snapshotBlock = includeFullSnapshot
    ? `SNAPSHOT
${snapshot.snapshotJson || "(no metric data in this user's log yet)"}
${groundingBlock}`
    : `SNAPSHOT
(The full health snapshot was provided earlier in this conversation — keep grounding your answer in those figures. Do not invent numbers you were not given.)
`;
  const userPrompt = `${snapshotBlock}${guidedBlock}
CONVERSATION
${transcript}

Reply now as the assistant, in ${locale === "de" ? "German" : "English"}.`;

  // v1.18.7 (SENIOR-DEV HIGH) — atomically RESERVE the day's budget before
  // the provider call. The reservation increments the day's total by the
  // per-call ceiling (`maxTokens`) in one upsert and returns the new total;
  // concurrent requests serialise on the row so they cannot all pass the cap.
  // Over-cap → 429 refusal frame, reservation already refunded. The actual
  // token count is reconciled against this reservation after the call,
  // including on empty / sentinel replies (their tokens were still burned).
  //
  // v1.20.0 (F1) — the tool loop makes up to MAX_ROUNDS provider round-trips,
  // so reserve the per-call ceiling × the round count up front and reconcile
  // the SUMMED actual tokens afterwards. The atomic reserve/reconcile
  // primitives are unchanged; only the reserved amount scales.
  const reqDateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    toolMode
      ? AI_BUDGETS.coach.maxTokens * MAX_ROUNDS
      : AI_BUDGETS.coach.maxTokens,
    reqDateKey,
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "coach.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter },
    });
    return streamProviderError({ code: "coach.budget.exceeded" });
  }

  let result: CompletionResult;
  let workingProviderType: string;
  let toolTrace: CoachToolTrace[] = [];
  let totalTokensSpent: number;
  try {
    if (toolMode) {
      // v1.20.0 (F1) — base context: the full system prompt + a tool-mode
      // grounding addendum, with the tiny DATA INVENTORY manifest and the
      // transcript on the user turn. The figures are NOT in the prompt — the
      // model pulls only what it needs via the retrieval tools. The inventory
      // build reuses the snapshot we already computed (60s LRU), so the tools
      // that fire this turn share its reads.
      const inventory = await buildCoachDataInventory(userId, effectiveScope);
      const toolSystem = `${systemPrompt}\n\n${buildToolModeAddendum(locale)}`;
      const messages: AiMessage[] = [
        {
          role: "user",
          content: `${renderDataInventory(inventory)}${guidedBlock}

CONVERSATION
${transcript}

Reply now as the assistant, in ${locale === "de" ? "German" : "English"}. Fetch any figures you cite with the tools first.`,
        },
      ];
      const loop = await runCoachToolLoop({
        userId,
        providers: chain,
        system: toolSystem,
        messages,
        tools: COACH_TOOL_DEFS,
        temperature: AI_BUDGETS.coach.temperature,
        maxTokens: AI_BUDGETS.coach.maxTokens,
        fallbackWindow: effectiveScope?.window,
      });
      result = loop.result;
      workingProviderType = loop.workingProviderType;
      toolTrace = loop.toolTrace;
      totalTokensSpent = loop.totalTokens;
    } else {
      const fallback = await runRawCompletionWithFallback({
        userId,
        providers: chain,
        // v1.20.0 — the no-tools path still builds one assembled user turn (the
        // transcript-flattening preserves the once-per-conversation snapshot
        // trick + grounding exactly), so it ships as a single user message. The
        // stable persona/grounding rides `system` and is now cache-eligible.
        params: singleUserTurn({
          system: systemPrompt,
          user: userPrompt,
          temperature: AI_BUDGETS.coach.temperature,
          maxTokens: AI_BUDGETS.coach.maxTokens,
        }),
      });
      result = fallback.result;
      workingProviderType = fallback.workingProvider.providerType;
      totalTokensSpent = result.tokensUsed ?? 0;
    }
  } catch (err) {
    // The provider chain failed outright — no tokens were billed, so refund
    // the full reservation before surfacing the error frame.
    await reconcileSpend(userId, reservation.reserved, 0, reqDateKey).catch(
      () => {},
    );
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

  // v1.18.7 (SENIOR-DEV MEDIUM) — the provider call returned, so its tokens
  // were billed regardless of reply quality. Reconcile the reservation
  // against the actual count NOW, before any empty/sentinel short-circuit, so
  // an empty or sentinel-only reply still records its burned cost (the old
  // post-hoc `recordSpend` ran only on the happy path, undercounting these).
  // v1.20.0 (F1) — reconcile against the SUMMED tokens across every tool round
  // (the loop accumulates them); the no-tools path sums to the single call.
  await reconcileSpend(
    userId,
    reservation.reserved,
    totalTokensSpent,
    reqDateKey,
  ).catch(() => {
    // Ledger reconcile is best-effort; a failure leaves the conservative
    // reservation in place (never an undercount) and never breaks the turn.
  });

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
  // v1.18.1 (Workstream C) — strip the optional `---SUGGEST-REMINDER---`
  // block out of the prose-after-keyvalues. The model proposes a cadence;
  // the gate decides whether it actually surfaces (module-toggle + opt-out
  // + dismissal memory + cooldown + dedup against a live COACH reminder).
  // A suppressed proposal leaves the prose unchanged and emits no card.
  const suggestParse = parseSuggestReminder(proseAfterStrip);
  let replyText = suggestParse.prose.trim() || proseAfterStrip;

  // v1.18.10 (HIGH-2) — OUTBOUND safety screen on the assembled assistant
  // reply, before persistence and streaming. The inbound `detectRefusal`
  // guards the user's message; this guards the model's reply for a
  // dose-prescription or a fabricated clinical risk score that slipped past
  // the system-prompt GLP-1/grounding contracts. On a trip the turn is
  // replaced with a calm, grounded fallback and any reminder suggestion /
  // key-value provenance is dropped — the user never sees the unsafe text.
  const outbound = screenCoachReply(replyText);
  if (outbound.block && outbound.reason) {
    replyText = coachOutboundFallback(outbound.reason, locale);
    annotate({
      action: { name: "insights.coach.outbound_blocked" },
      meta: { reason: outbound.reason, promptVersion: PROMPT_VERSION },
    });
    await auditLog("insights.coach.outbound_blocked", {
      userId,
      details: {
        conversationId: workingConversationId,
        reason: outbound.reason,
      },
    });
  }

  let surfacedSuggestion: CoachSuggestion | null = null;
  if (!outbound.block && suggestParse.cadence) {
    const decision = await gateSuggestion({
      prisma,
      userId,
      cadence: suggestParse.cadence,
      prefs:
        coachPrefs.reminderSuggestions ?? DEFAULT_REMINDER_SUGGESTION_PREFS,
    });
    if (decision.surface) {
      const cadence = suggestParse.cadence;
      surfacedSuggestion = {
        cadenceId: cadence.id,
        measurementType: cadence.measurementType,
        label: cadence.labelKey,
      };
      // Stamp the cooldown anchor (frequency cap) onto the prefs blob.
      const nextSuggestionPrefs = {
        ...(coachPrefs.reminderSuggestions ??
          DEFAULT_REMINDER_SUGGESTION_PREFS),
        lastSuggestedAt: new Date().toISOString(),
      };
      void prisma.user
        .update({
          where: { id: userId },
          data: {
            coachPrefsJson: {
              ...coachPrefs,
              reminderSuggestions: nextSuggestionPrefs,
            },
          },
        })
        .catch(() => {
          // Cooldown stamp is best-effort: a write failure at worst lets a
          // second suggestion through sooner, never breaks the chat turn.
        });
      annotate({
        action: { name: "coach.reminder.suggested" },
        meta: { cadenceId: cadence.id, metric: cadence.measurementType },
      });
    } else {
      annotate({
        action: { name: "coach.reminder.suppressed" },
        meta: { cadenceId: suggestParse.cadence.id, reason: decision.reason },
      });
    }
  }
  const enrichedProvenance: typeof snapshot.provenance = {
    ...snapshot.provenance,
    // v1.18.10 (HIGH-2) — a blocked turn carries the fallback prose, so the
    // key-values from the discarded reply must not ride along as provenance.
    ...(!outbound.block && sentinel.keyValues.length > 0
      ? { keyValues: sentinel.keyValues }
      : {}),
    ...(surfacedSuggestion ? { suggestion: surfacedSuggestion } : {}),
    // v1.20.0 (F1) — persist the retrieval-tool trace (which tools ran +
    // whether each found data) so a reload can show "what I looked at" and the
    // audit can replay grounding. Metadata only.
    ...(toolTrace.length > 0
      ? {
          toolCalls: toolTrace.map((t) => ({
            name: t.name,
            present: t.present,
          })),
        }
      : {}),
  };
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
    // v1.18.9 — persist the per-turn token count + model so the quiet
    // token footer survives a conversation reload. The live turn paints
    // from the `done.usage` SSE frame below; reloads read these columns.
    // v1.20.0 (F1) — the summed cost across every tool round, so the footer
    // reflects the true turn cost on the tool path too.
    tokensUsed: totalTokensSpent || null,
    model: result.model ?? null,
  });

  // v1.18.7 — the day's spend was already reconciled against the
  // reservation immediately after the provider returned (above), so there is
  // no post-persistence ledger bump here. The reservation guarantees the
  // tokens are counted even if persistence or streaming fails afterwards.

  annotate({
    action: { name: "insights.coach.replied" },
    meta: {
      provider: workingProviderType,
      // v1.20.0 (F1) — summed tokens across every tool round (the loop) or the
      // single call (no-tools path), so the dashboards see the true turn cost.
      tokens: totalTokensSpent,
      promptVersion: PROMPT_VERSION,
      conversationId: workingConversationId,
      historyTurns: window.length,
      // v1.20.0 (F1) — whether this turn ran the tool-retrieval path, and how
      // many tools it fetched, so the dashboards can correlate the token delta
      // with the new path vs the legacy snapshot path.
      toolMode,
      toolsCalled: toolTrace.length,
      // v1.19.1 (C4) — whether the full SNAPSHOT block rode this turn (the
      // expensive prefix) vs the cheap pointer. On the tool path the snapshot
      // never rides the prompt, so this is the legacy-path signal only.
      snapshotSent: !toolMode && includeFullSnapshot,
      promptChars: userPrompt.length,
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
      // v1.18.10 (A-2) — stop tokenising the moment the client disconnects;
      // the cancel handler flips this signal, so we don't pace frames into a
      // closed connection.
      if (controller.signal.aborted) return;
      controller.enqueue(encodeFrame({ type: "token", token: tok }));
      await flushTick();
    }
    if (controller.signal.aborted) return;
    controller.enqueue(
      encodeFrame({
        type: "provenance",
        metricSource: enrichedProvenance,
      }),
    );
    // v1.18.1 (Workstream C) — additive `suggestion` frame. Older clients
    // ignore it; newer ones render the one-tap action card.
    if (surfacedSuggestion) {
      controller.enqueue(
        encodeFrame({ type: "suggestion", suggestion: surfacedSuggestion }),
      );
    }
    // v1.18.9 — additive `usage` envelope on the `done` frame so the client
    // can paint the quiet per-message token footer the instant the stream
    // closes. Server-authoritative: the client renders these numbers, never
    // recomputes them. Older clients drop the unknown key.
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId: workingConversationId,
        messageId: assistantMessage.id,
        usage: {
          // v1.20.0 (F1) — summed across every tool round.
          totalTokens: totalTokensSpent || null,
          model: result.model ?? null,
        },
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
  // v1.18.0 — same two-layer module gate as the SSE POST.
  const gate = await requireModuleEnabled(auth.user.id, "coach");
  if (!gate.enabled) return gate.response;
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
