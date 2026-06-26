/**
 * v1.20.0 (F1) — bounded Coach retrieval loop.
 *
 * Runs the agentic call → tool-result → answer cycle on top of the existing
 * `runRawCompletionWithFallback` chain. Each round is a NON-streaming
 * completion (the chain returns a whole body); the route fake-tokenises the
 * FINAL prose for the visible stream exactly as before.
 *
 * Bounds (the loop can never run away):
 *   - MAX_ROUNDS = 2: one tool-fetch round + the answer round.
 *   - HARD_CAP = 3: an absolute ceiling; on the last allowed round the loop
 *     re-calls with `toolChoice:"none"` so the model is FORCED to produce prose
 *     even if it would otherwise keep asking for tools.
 *   - Tool calls within a round run in parallel (`Promise.all`).
 *
 * Token accounting: the caller reserves `maxTokens * MAX_ROUNDS` up front and
 * reconciles the SUMMED `tokensUsed` this function returns. The atomic
 * reserve/reconcile primitives are unchanged.
 *
 * Provider fallback: when the working provider does not support tools
 * (`supportsTools === false`) or returns no tool calls, the loop degrades to a
 * single completion — the caller falls back to the snapshot path BEFORE
 * entering this loop, so this is the safety floor, not the primary route.
 */
import { annotate } from "@/lib/logging/context";
import { runRawCompletionWithFallback } from "@/lib/ai/provider-runner";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type { AiMessage, AiToolDef, CompletionResult } from "@/lib/ai/types";
import type { ProviderHealthLedger } from "@/lib/ai/provider-health-ledger";
import type { CoachScopeWindow } from "@/lib/ai/coach/types";
import {
  executeCoachTool,
  type CoachToolResult,
  type CoachToolTrace,
} from "./executor";

export const MAX_ROUNDS = 2;
/** Absolute ceiling; the final allowed round forces prose (toolChoice none). */
export const HARD_CAP = 3;

export interface CoachToolLoopResult {
  /** The final completion (prose). */
  result: CompletionResult;
  /** The working provider's type tag. */
  workingProviderType: string;
  /** Summed tokens across every round (for budget reconcile). */
  totalTokens: number;
  /** Number of model round-trips made. */
  rounds: number;
  /** Which tools ran + whether each found data (persisted onto provenance). */
  toolTrace: CoachToolTrace[];
  /**
   * v1.21.0 (P6) — the structured payloads of every PRESENT tool result this
   * turn, in call order. The post-hoc prose number-verifier extracts the
   * numeric leaves from these to cross-check the figures the model cited. Empty
   * on a no-tools answer.
   */
  toolResults: CoachToolResult[];
}

export async function runCoachToolLoop(args: {
  userId: string;
  providers: ProviderChainResolved[];
  system: string;
  /** The conversation messages (history + the new user turn). */
  messages: AiMessage[];
  tools: AiToolDef[];
  temperature?: number;
  maxTokens?: number;
  fallbackWindow?: CoachScopeWindow;
  ledger?: ProviderHealthLedger;
  /** Aborts the per-round provider calls on client disconnect. */
  signal?: AbortSignal;
}): Promise<CoachToolLoopResult> {
  const {
    userId,
    providers,
    system,
    tools,
    temperature,
    maxTokens,
    fallbackWindow,
    ledger,
    signal,
  } = args;

  const messages: AiMessage[] = [...args.messages];
  let totalTokens = 0;
  let rounds = 0;
  let workingProviderType = "";
  const toolTrace: CoachToolTrace[] = [];
  const toolResults: CoachToolResult[] = [];

  // Round budget: rounds 1..HARD_CAP. On the last allowed round we forbid tool
  // calls so the model must answer.
  for (let round = 1; round <= HARD_CAP; round += 1) {
    rounds = round;
    const isForcedFinal = round >= HARD_CAP;
    const offerTools = round <= MAX_ROUNDS && !isForcedFinal;

    const fallback = await runRawCompletionWithFallback({
      userId,
      providers,
      ledger,
      params: {
        system,
        messages,
        temperature,
        maxTokens,
        signal,
        ...(offerTools
          ? { tools, toolChoice: "auto" as const }
          : { toolChoice: "none" as const }),
      },
    });
    const result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
    totalTokens += result.tokensUsed ?? 0;

    const calls = result.toolCalls ?? [];
    const wantsTools =
      offerTools && result.finishReason === "tool_calls" && calls.length > 0;

    if (!wantsTools) {
      // The model produced prose (or a no-tools provider returned empty
      // toolCalls) — we are done.
      annotate({
        action: { name: "coach.tool.rounds" },
        meta: {
          rounds,
          tools: toolTrace.length,
          forcedFinal: isForcedFinal,
        },
      });
      return {
        result,
        workingProviderType,
        totalTokens,
        rounds,
        toolTrace,
        toolResults,
      };
    }

    // Append the assistant turn that requested the tools, then execute them in
    // parallel and append one tool-result turn per call.
    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls,
    });

    const results = await Promise.all(
      calls.map(async (call) => {
        const toolResult = await executeCoachTool({
          userId,
          name: call.name,
          rawArguments: call.arguments,
          fallbackWindow,
        });
        toolTrace.push({ name: call.name, present: toolResult.present });
        // v1.21.0 (P6) — retain the present results' payloads for the post-hoc
        // prose number-verifier (the union of numeric leaves grounds the
        // figures the model may cite).
        if (toolResult.present) toolResults.push(toolResult);
        return { call, toolResult };
      }),
    );

    for (const { call, toolResult } of results) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  // Unreachable: the forced-final round (round === HARD_CAP) always returns
  // above because `offerTools` is false, so `wantsTools` is false. Kept as a
  // defensive guard.
  throw new Error("coach tool loop exceeded hard cap without a final answer");
}
