"use client";

/**
 * v1.27.33 (Document vault P4) — client hooks for the scoped "chat about this
 * document" panel: the prior-thread history (GET) and the SSE-streaming send
 * (POST). Deliberately lean — one active thread per document, no tools, no
 * snapshot; the whole feature is a single grounded completion per turn on the
 * server, so the client only needs a message list + a live streaming tail.
 *
 * Streaming reuses the Coach's pure SSE frame parser (`parseSseChunk`) — the
 * document route emits the same `token` / `done` / `error` wire frames (a subset
 * of `CoachStreamEvent`). Assistant prose renders as PLAIN React text on the
 * panel (no markdown library, the project's XSS posture); this hook only carries
 * the raw string.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CoachConversationDetailDTO,
  CoachConversationsPage,
} from "@/lib/ai/coach/types";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

import { parseSseChunk } from "@/components/insights/coach-panel/use-coach";

/** One persisted turn in a document chat, trimmed to what the panel renders. */
export interface DocumentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** The document's active chat thread: the newest conversation + its messages. */
export interface DocumentChatThread {
  conversationId: string | null;
  messages: DocumentChatMessage[];
}

const EMPTY_THREAD: DocumentChatThread = {
  conversationId: null,
  messages: [],
};

/**
 * Load the document's active chat thread. The list endpoint returns the
 * document's conversations newest-first; the panel keeps ONE active thread, so
 * this resolves the newest conversation and fetches its decrypted messages in a
 * single query. Returns an empty thread when the document has never been chatted
 * about (no conversation yet) — the panel then starts a fresh one on first send.
 */
export function useDocumentChatThread(
  documentId: string | null,
  enabled: boolean,
) {
  return useQuery<DocumentChatThread>({
    queryKey: queryKeys.inboundDocumentChat(documentId ?? "none"),
    enabled: enabled && documentId !== null,
    staleTime: 30_000,
    queryFn: async () => {
      if (!documentId) return EMPTY_THREAD;
      const page = await apiGet<CoachConversationsPage>(
        `/api/documents/inbound/${documentId}/chat`,
      );
      const newest = page.conversations[0];
      if (!newest) return EMPTY_THREAD;
      const detail = await apiGet<CoachConversationDetailDTO>(
        `/api/documents/inbound/${documentId}/chat?conversationId=${encodeURIComponent(
          newest.id,
        )}`,
      );
      return {
        conversationId: detail.id,
        messages: detail.messages.map((m) => ({
          id: m.id,
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          createdAt: m.createdAt,
        })),
      };
    },
  });
}

/** Live state of the assistant turn currently streaming into the panel. */
export interface DocumentChatStreamingState {
  /** Concatenated tokens received so far. */
  content: string;
  /** True until the `done` frame closes the stream. */
  inProgress: boolean;
  /** Server-side error code from an `error` frame / rejected POST, if any. */
  errorCode: string | null;
}

const EMPTY_STREAMING: DocumentChatStreamingState = {
  content: "",
  inProgress: false,
  errorCode: null,
};

export interface SendDocumentChatParams {
  conversationId?: string;
  message: string;
  locale?: "en" | "de";
}

/**
 * The streaming send hook. `send()` POSTs the turn to the document chat route,
 * walks the SSE byte stream, and updates `streaming` after every frame. On the
 * `done` frame the document's chat thread cache is invalidated so the persisted
 * (encrypted-on-disk) history reloads with the canonical message ids. An
 * `optimisticUser` bubble surfaces the just-sent message immediately, before the
 * assistant's placeholder, and is cleared once the persisted twin lands.
 */
export function useSendDocumentChatMessage(documentId: string) {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] =
    useState<DocumentChatStreamingState>(EMPTY_STREAMING);
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setStreaming(EMPTY_STREAMING);
    setOptimisticUser(null);
  }, []);

  useEffect(() => {
    // Cancel any in-flight stream when the panel unmounts / document switches.
    return () => abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (params: SendDocumentChatParams): Promise<string | null> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setOptimisticUser(params.message);
      setStreaming({ content: "", inProgress: true, errorCode: null });

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStreaming({
          content: "",
          inProgress: false,
          errorCode: "documents.chat.network",
        });
        return null;
      }

      // apiFetchRaw: the POST streams SSE — the envelope helpers would buffer
      // and unwrap a body that never carries the envelope.
      let response: Response;
      try {
        response = await apiFetchRaw(
          `/api/documents/inbound/${documentId}/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              conversationId: params.conversationId,
              message: params.message,
              locale: params.locale,
            }),
            signal: controller.signal,
          },
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") return null;
        setStreaming({
          content: "",
          inProgress: false,
          errorCode: "documents.chat.network",
        });
        return null;
      }

      const contentType = response.headers.get("Content-Type") ?? "";
      const isEventStream = contentType
        .toLowerCase()
        .startsWith("text/event-stream");

      // A rejected turn (rate limit, budget, consent, not-indexed) is a JSON
      // error envelope, not an SSE body. Surface its structured `error` code so
      // the panel shows the right copy; keep the optimistic bubble standing next
      // to it (no persisted twin is coming).
      if (!response.ok && !isEventStream) {
        let structured: string | null = null;
        try {
          const envelope = (await response.clone().json()) as {
            error?: unknown;
            meta?: { errorCode?: unknown };
          };
          if (envelope?.meta && typeof envelope.meta.errorCode === "string") {
            structured = envelope.meta.errorCode;
          } else if (typeof envelope?.error === "string") {
            structured = envelope.error;
          }
        } catch {
          // body was not JSON; fall through to the http-status fallback
        }
        setStreaming({
          content: "",
          inProgress: false,
          errorCode: structured ?? `documents.chat.http.${response.status}`,
        });
        return null;
      }

      if (!response.body) {
        setStreaming({
          content: "",
          inProgress: false,
          errorCode: `documents.chat.http.${response.status}`,
        });
        return null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let collectedContent = "";
      let resolvedConversationId: string | null = null;
      let lastError: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buffer, text);
          buffer = rest;
          for (const evt of events) {
            switch (evt.type) {
              case "token":
                collectedContent += evt.token;
                setStreaming((prev) => ({
                  ...prev,
                  content: prev.content + evt.token,
                }));
                break;
              case "done":
                resolvedConversationId = evt.conversationId;
                break;
              case "error":
                lastError = evt.code;
                break;
              default:
                // Additive wire frames (provenance / suggestion / …) never
                // occur on the document route; ignore them defensively.
                break;
            }
          }
        }
        const tail = parseSseChunk(buffer, "\n\n");
        for (const evt of tail.events) {
          if (evt.type === "done") resolvedConversationId = evt.conversationId;
          else if (evt.type === "error") lastError = evt.code;
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          lastError = "documents.chat.stream";
        }
      }

      setStreaming({
        content: collectedContent,
        inProgress: false,
        errorCode: lastError,
      });

      if (resolvedConversationId) {
        // Reload the encrypted-on-disk thread (canonical ids + any outbound
        // editorialisation). The persisted twin replaces the optimistic bubble.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.inboundDocumentChat(documentId),
        });
        setOptimisticUser(null);
      }
      return resolvedConversationId;
    },
    [documentId, queryClient],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return {
    streaming,
    isStreaming: streaming.inProgress,
    optimisticUser,
    send,
    cancel,
    reset,
  };
}
