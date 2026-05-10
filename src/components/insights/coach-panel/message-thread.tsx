"use client";

import { useEffect, useRef } from "react";
import { Bot, ChevronRight, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { SourceChips } from "./source-chips";
import type {
  CoachConversationDetailDTO,
  CoachStreamingMessage,
} from "./use-coach";
import type { CoachMessageDTO } from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — message-thread renderer.
 *
 * Mounted inside the centre column of the Coach drawer. Renders the
 * persisted message history (decrypted server-side and delivered as
 * `CoachMessageDTO[]`) + an optional in-flight assistant bubble fed
 * by the streaming hook.
 *
 * Auto-scroll behaviour: scrolls to the bottom whenever the message
 * list grows OR the streaming-content length changes. The user can
 * scroll up to read history; we suppress auto-scroll until the next
 * "new message" tick if they're not already pinned to the bottom.
 *
 * Visual identity: user bubbles right-aligned, Dracula purple accent;
 * assistant bubbles left-aligned with the gradient sparkle avatar
 * from the artboard.
 */
export interface MessageThreadProps {
  conversation: CoachConversationDetailDTO | null;
  /** Optional in-flight bubble from `useSendCoachMessage()`. */
  streaming?: CoachStreamingMessage;
  /** Empty-state copy when no conversation is loaded yet. */
  emptyHint?: string;
}

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function MessageThread({
  conversation,
  streaming,
  emptyHint,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);

  const messages: CoachMessageDTO[] = conversation?.messages ?? [];
  // v1.4.20.1 — once the SSE stream emits `done`, the route's
  // invalidate-then-refetch pulls the persisted assistant message into
  // `conversation.messages`. The streaming bubble was still rendering
  // because the hook keeps `streaming.content` populated to support
  // the in-flight render path; the result was two assistant bubbles
  // side by side until the next `send` reset the streaming state.
  // Suppress the streaming bubble at render time as soon as the
  // persisted twin lands — comparing on `messageId` keeps the
  // transition seamless while never accidentally hiding an in-flight
  // bubble (during streaming `messageId` is null).
  const streamingPersisted =
    streaming?.messageId != null &&
    messages.some((m) => m.id === streaming.messageId);
  const streamingActive =
    !streamingPersisted &&
    (!!streaming?.inProgress || !!streaming?.content || !!streaming?.errorCode);

  // Track scroll position so we don't yank the viewport when the user
  // is browsing earlier turns.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasPinnedRef.current = isPinnedToBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages OR streaming-content growth, but only
  // when the user was already at the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, streaming?.content]);

  if (messages.length === 0 && !streamingActive) {
    return (
      <div
        data-slot="coach-message-thread"
        className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div
          aria-hidden="true"
          className="from-dracula-purple to-dracula-pink flex size-12 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-5" />
        </div>
        <p className="max-w-sm text-sm leading-relaxed">
          {emptyHint ?? t("insights.coach.threadEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      data-slot="coach-message-thread"
      className={cn(
        "flex h-full flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6",
        "scroll-smooth",
      )}
    >
      {messages.map((m) => (
        <ChatBubble
          key={m.id}
          role={m.role}
          content={m.content}
          metricSource={m.metricSource}
          providerType={m.providerType}
        />
      ))}
      {streamingActive && streaming && (
        // role=log + aria-live=polite so screen-reader users hear the
        // assistant prose announce as tokens land. aria-relevant=text
        // limits announcements to the streamed content; additions
        // covers the bubble-mount edge case.
        <div role="log" aria-live="polite" aria-relevant="additions text">
          <ChatBubble
            role="assistant"
            content={streaming.content}
            metricSource={streaming.metricSource}
            providerType={streaming.inProgress ? "streaming" : null}
            inProgress={streaming.inProgress}
            errorCode={streaming.errorCode}
          />
        </div>
      )}
    </div>
  );
}

interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  metricSource?: import("@/lib/ai/coach/types").CoachProvenance | null;
  providerType?: string | null;
  inProgress?: boolean;
  errorCode?: string | null;
}

function ChatBubble({
  role,
  content,
  metricSource,
  providerType,
  inProgress,
  errorCode,
}: ChatBubbleProps) {
  const { t } = useTranslations();
  if (role === "user") {
    return (
      <div
        data-slot="coach-bubble-user"
        className="flex items-start justify-end gap-2"
      >
        <div
          className={cn(
            "border-dracula-purple/30 bg-dracula-purple/12 text-foreground",
            "max-w-[80%] rounded-xl rounded-tr-sm border px-3.5 py-2.5",
            "text-sm leading-relaxed",
          )}
        >
          {content}
        </div>
        <div
          aria-hidden="true"
          className="text-muted-foreground bg-muted/60 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
        >
          <User className="size-3.5" />
        </div>
      </div>
    );
  }

  const errorMessage = errorCode ? t(`insights.coach.${errorCode}`, {}) : null;
  // When a translated message comes back unchanged (i.e. key missing) we
  // fall back to a generic provider error string so the bubble doesn't
  // surface raw `coach.http.503` text to the user.
  const safeError =
    errorMessage && errorMessage !== `insights.coach.${errorCode}`
      ? errorMessage
      : errorCode
        ? t("insights.coach.errorProvider")
        : null;

  const keyValues = metricSource?.keyValues ?? [];

  return (
    <div
      data-slot="coach-bubble-assistant"
      className="flex items-start gap-2.5"
    >
      <div
        aria-hidden="true"
        className="from-dracula-purple to-dracula-pink mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
      >
        {providerType === "refusal" ? (
          <Bot className="text-background size-3.5" />
        ) : (
          <Sparkles className="text-background size-3.5" />
        )}
      </div>
      <div className="flex max-w-[80%] flex-col gap-2">
        <div
          className={cn(
            "border-border/60 bg-muted/40 text-foreground",
            "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
            "text-sm leading-relaxed whitespace-pre-wrap",
            inProgress && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {content || (inProgress ? t("insights.coach.thinking") : "")}
        </div>
        {safeError && (
          <p className="text-dracula-orange/90 text-xs">{safeError}</p>
        )}
        {metricSource && <SourceChips provenance={metricSource} />}
        {keyValues.length > 0 && (
          <details
            data-slot="coach-evidence"
            className={cn(
              "border-border/50 bg-muted/30 group rounded-md border",
              "px-2.5 py-1.5 text-xs",
            )}
          >
            <summary
              data-slot="coach-evidence-summary"
              className={cn(
                "text-muted-foreground hover:text-foreground flex cursor-pointer",
                "items-center gap-1.5 leading-relaxed",
                "[&::-webkit-details-marker]:hidden marker:hidden",
                "focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-2",
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-3 transition-transform group-open:rotate-90"
              />
              <span>{t("insights.coach.evidenceLabel")}</span>
            </summary>
            <ul
              data-slot="coach-evidence-list"
              className="text-foreground mt-2 flex flex-col gap-1"
            >
              {keyValues.map((kv, idx) => (
                <li
                  key={`${kv.label}-${idx}`}
                  data-slot="coach-evidence-row"
                  className="leading-relaxed"
                >
                  <span className="text-muted-foreground">{kv.label}:</span>{" "}
                  <strong className="font-semibold">
                    {kv.value}
                    {kv.unit ? ` ${kv.unit}` : ""}
                  </strong>
                  {kv.window && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({kv.window})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
