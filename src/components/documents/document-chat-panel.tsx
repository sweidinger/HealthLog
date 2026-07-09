"use client";

/**
 * v1.27.33 (Document vault P4) — the "Chat about this document" panel that lives
 * inside the detail sheet's AI area, beneath the "Read with AI" actions. It opens
 * a scoped conversation grounded ONLY in this one document's stored text: a
 * message list + an input that streams the assistant reply token-by-token over
 * the SSE route, with prior turns loaded via GET.
 *
 * Rendered by the sheet ONLY when a provider is available (it fills
 * `DocumentAiSection`'s `chatSlot`, which sits in the provider-available branch),
 * so the panel itself only gates on whether the document is content-INDEXED —
 * the text is the sole grounding. Not indexed → a calm "read it with AI first"
 * hint (never an error), pointing at the action directly above.
 *
 * Rendering posture (matches the rest of the AI surfaces): assistant prose is
 * PLAIN React text via `ProseBlocks` / `StreamedProse` — there is no markdown
 * library and no `dangerouslySetInnerHTML` (the project's XSS rule). Any citation
 * the model emits ("per the report's Impression…") is just text. A one-line
 * safety note states answers describe the document and are not medical advice,
 * consistent with the summary panel's "not a diagnosis".
 *
 * This module owns the PURE surface: `DocumentChatConversation` renders the
 * open body (log + input + safety note) from props, so the conversation is
 * statically renderable and pinned by tests without a query client, and
 * `documentChatErrorKey` maps a server / client code to a calm copy key. The
 * stateful container (hooks + open/gate state) lives in
 * `document-chat-drawer.tsx`, which presents this body in the Coach drawer
 * chrome scoped to a single document.
 */
import { MessageSquare, Send } from "lucide-react";
import { type RefObject } from "react";

import { StreamedProse } from "@/components/insights/coach-panel/streamed-prose";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { type DocumentChatMessage } from "./use-document-chat";

/** Map a server / client error code to a calm translation key. */
export function documentChatErrorKey(code: string | null): string {
  switch (code) {
    case "documents.chat.provider.rate_limited":
    case "documents.inbound.rateLimited":
      return "documents.chat.errorRateLimited";
    case "documents.chat.budget.exceeded":
      return "documents.chat.errorBudget";
    case "documents.chat.provider.credential_expired":
      return "documents.chat.errorCredential";
    case "consent.ai.required":
      return "documents.chat.errorConsent";
    case "documents.chat.network":
      return "documents.chat.errorNetwork";
    default:
      return "documents.chat.errorGeneric";
  }
}

/** One settled turn — user bubble right, assistant prose left (plain text). */
function ChatTurn({ message }: { message: DocumentChatMessage }) {
  if (message.role === "user") {
    return (
      <div
        data-slot="document-chat-message"
        data-role="user"
        className="flex justify-end"
      >
        <div className="bg-primary/10 border-primary/20 text-foreground max-w-[85%] rounded-xl rounded-tr-sm border px-3 py-2 text-sm leading-relaxed">
          {/* User text is verbatim: no chart-token strip, no Learn linkify. */}
          <ProseBlocks text={message.content} strip={false} linkify={false} />
        </div>
      </div>
    );
  }
  return (
    <div
      data-slot="document-chat-message"
      data-role="assistant"
      className="flex justify-start"
    >
      <div className="bg-card border-border text-foreground max-w-[85%] rounded-xl rounded-tl-sm border px-3 py-2 text-sm">
        <ProseBlocks text={message.content} />
      </div>
    </div>
  );
}

/**
 * The open conversation body — pure (props in, markup out). Renders the message
 * log (persisted + optimistic + streaming tail), the composer, the always-on
 * safety note, and a close control. No hooks that need a query client, so it is
 * statically renderable and unit-pinned.
 */
export function DocumentChatConversation({
  messages,
  optimisticContent,
  streamingContent,
  isStreaming,
  streamErrorKey,
  historyPending,
  historyError,
  draft,
  onDraftChange,
  onSubmit,
  onClose,
  logRef,
}: {
  messages: DocumentChatMessage[];
  /** The optimistic user turn to render, or null when none is pending. */
  optimisticContent: string | null;
  /** Concatenated streamed assistant tokens so far (empty until the first). */
  streamingContent: string;
  isStreaming: boolean;
  /** Translation key for a stream error, or null. */
  streamErrorKey: string | null;
  historyPending: boolean;
  historyError: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  logRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslations();
  const isEmpty =
    !historyPending &&
    messages.length === 0 &&
    optimisticContent === null &&
    !isStreaming &&
    streamingContent.length === 0;

  return (
    <div
      data-slot="document-chat"
      data-state="open"
      className="border-border/60 space-y-3 border-t pt-3"
    >
      <div className="flex items-center gap-2">
        <MessageSquare
          className="text-foreground size-4 shrink-0"
          aria-hidden
        />
        <p className="text-sm font-semibold">{t("documents.chat.title")}</p>
      </div>

      <div
        ref={logRef}
        data-slot="document-chat-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={t("documents.chat.title")}
        className="max-h-72 space-y-3 overflow-y-auto overscroll-contain"
      >
        {historyPending ? (
          <div className="space-y-2" data-slot="document-chat-loading">
            <Skeleton className="ml-auto h-8 w-2/3 rounded-xl" />
            <Skeleton className="h-12 w-4/5 rounded-xl" />
          </div>
        ) : null}

        {isEmpty ? (
          <p
            data-slot="document-chat-empty"
            className="text-muted-foreground text-xs"
          >
            {t("documents.chat.empty")}
          </p>
        ) : null}

        {messages.map((m) => (
          <ChatTurn key={m.id} message={m} />
        ))}

        {optimisticContent !== null ? (
          <ChatTurn
            message={{
              id: "optimistic",
              role: "user",
              content: optimisticContent,
              createdAt: "",
            }}
          />
        ) : null}

        {isStreaming && streamingContent.length === 0 && !streamErrorKey ? (
          <p
            data-slot="document-chat-thinking"
            className="text-muted-foreground text-xs"
          >
            {t("documents.chat.thinking")}
          </p>
        ) : null}

        {streamingContent.length > 0 ? (
          <div
            data-slot="document-chat-message"
            data-role="assistant"
            className="flex justify-start"
          >
            <div className="bg-card border-border text-foreground max-w-[85%] rounded-xl rounded-tl-sm border px-3 py-2 text-sm">
              <StreamedProse
                content={streamingContent}
                streaming={isStreaming}
              />
            </div>
          </div>
        ) : null}
      </div>

      {streamErrorKey ? (
        <p role="alert" className="text-destructive text-sm">
          {t(streamErrorKey)}
        </p>
      ) : null}

      {historyError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("documents.chat.errorHistory")}
        </p>
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={t("documents.chat.placeholder")}
          aria-label={t("documents.chat.inputLabel")}
          maxLength={4000}
          disabled={isStreaming}
          data-slot="document-chat-input"
          autoComplete="off"
        />
        <Button
          type="submit"
          size="icon"
          data-slot="document-chat-send"
          disabled={isStreaming || draft.trim().length === 0}
          aria-label={t("documents.chat.send")}
        >
          <Send className="size-4" aria-hidden />
        </Button>
      </form>

      {/* Safety-visible: answers describe the document, not medical advice —
          consistent with the summary panel's "not a diagnosis". */}
      <p
        data-slot="document-chat-safety"
        className="text-muted-foreground text-xs"
      >
        {t("documents.chat.safety")}
      </p>

      {/* Retiring the panel discards the live stream state (the persisted
          history stays on disk and reloads next open). */}
      <button
        type="button"
        data-slot="document-chat-close"
        onClick={onClose}
        className={cn(
          "text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline",
        )}
      >
        {t("documents.chat.close")}
      </button>
    </div>
  );
}
