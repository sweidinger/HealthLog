import type {
  AiContentPart,
  AiMessage,
  AiToolCall,
  AiToolDef,
  CompletionResult,
} from "./types";

/**
 * Shared OpenAI Chat-Completions wire mapping. Both the hosted OpenAI client
 * and the local OpenAI-compatible client (Ollama / LM Studio / vLLM) speak this
 * shape, so the message → wire translation and the response parsing live here
 * once. The two clients differ only in how they treat `responseFormat` and the
 * endpoint/auth, not in the message structure.
 */

type OpenAIChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: OpenAIChatContent | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Map a single `AiMessage` content into the Chat-Completions content shape.
 * A plain string stays a string (byte-identical to the text-only wire we shipped
 * before the refactor); parts become the multimodal array. PDF document parts
 * are dropped — the Chat-Completions wire has no document block (the OCR route
 * gates PDFs to Anthropic).
 */
function mapContent(content: string | AiContentPart[]): OpenAIChatContent {
  if (typeof content === "string") return content;
  const out: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  for (const part of content) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      out.push({
        type: "image_url",
        image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
      });
    }
    // `document` parts are not representable on this wire; drop them.
  }
  return out;
}

/**
 * Build the full Chat-Completions `messages[]` array: the system turn first,
 * then every conversation turn mapped 1:1. Assistant `toolCalls` and the
 * `role:"tool"` result turns map to the OpenAI tool wire so a multi-round
 * tool loop (F1) round-trips.
 */
export function buildOpenAIMessages(
  system: string,
  messages: AiMessage[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content:
          typeof m.content === "string" ? m.content : mapContent(m.content),
      });
      continue;
    }
    const mapped: OpenAIChatMessage = {
      role: m.role,
      content: mapContent(m.content),
    };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      mapped.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    out.push(mapped);
  }
  return out;
}

/** Map tool defs into the OpenAI `tools` array. */
export function buildOpenAITools(tools: AiToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponseJson {
  choices?: OpenAIChoice[];
  usage?: {
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Map the OpenAI `finish_reason` onto the provider-neutral finishReason. */
export function mapFinishReason(
  reason: string | undefined,
): CompletionResult["finishReason"] {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  return undefined;
}

/** Pull tool calls off an OpenAI choice into the provider-neutral shape. */
export function parseOpenAIToolCalls(
  choice: OpenAIChoice | undefined,
): AiToolCall[] | undefined {
  const calls = choice?.message?.tool_calls;
  if (!calls || calls.length === 0) return undefined;
  return calls.map((c) => ({
    id: c.id ?? "",
    name: c.function?.name ?? "",
    arguments: c.function?.arguments ?? "",
  }));
}

export function parseCachedTokens(json: OpenAIResponseJson): number | null {
  return json.usage?.prompt_tokens_details?.cached_tokens ?? null;
}

export type { OpenAIChoice, OpenAIResponseJson };
