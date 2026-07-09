"use client";

/**
 * The scoped "chat about this document" surface, presented in the Coach chat
 * drawer chrome (right-side `<Sheet>` on desktop, bottom sheet on phones — the
 * same width caps and slide behaviour as the general Coach drawer). It is
 * CHROME reuse only: the conversation body, the client hooks, and the endpoint
 * stay the document-scoped ones, so the v1.27.33 posture is untouched — the
 * drawer POSTs `/api/documents/inbound/[id]/chat` (no tools, no health
 * snapshot, fenced document, inbound/replay refusal, outbound screen, numeric
 * grounding, consent + budget + per-user rate bucket, indexed-only), and the
 * assistant prose renders as PLAIN React text (no markdown library, no
 * `dangerouslySetInnerHTML`).
 *
 * Unlike the general Coach drawer this one has NO maximize and NO
 * conversations rail — both hand off to `/coach`, which does not apply to a
 * single document thread. It carries a quiet scope badge ("Chatting about:
 * <document>") so the user always sees the conversation is fenced to this one
 * document, and a single close control.
 *
 * Open/close is owned by the detail sheet (the top-right neutral Coach icon
 * toggles it); this component is fully controlled. When the document is not
 * content-indexed the body shows the calm read-it-first hint (never an error),
 * matching the former inline panel.
 */
import { FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  DocumentChatConversation,
  documentChatErrorKey,
} from "./document-chat-panel";
import {
  useDocumentChatThread,
  useSendDocumentChatMessage,
} from "./use-document-chat";

export function DocumentChatDrawer({
  open,
  onOpenChange,
  documentId,
  indexed,
  documentTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  /** True when the document has a content index (its text grounds the chat). */
  indexed: boolean;
  /** Resolved document title for the scope badge. */
  documentTitle: string;
}) {
  const { t, locale } = useTranslations();
  // Below `sm` (640 px) the drawer slides up from the bottom edge so the
  // header chrome stays near the user's thumb; above it keeps the right-side
  // slide + width cap — the same behaviour as the general Coach drawer.
  const isPhoneViewport = useIsMobile("sm");

  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const thread = useDocumentChatThread(documentId, open && indexed);
  const { streaming, isStreaming, optimisticUser, send, reset } =
    useSendDocumentChatMessage(documentId);

  const messages = thread.data?.messages ?? [];
  const conversationId = thread.data?.conversationId ?? undefined;

  // The optimistic bubble is dropped once its persisted twin lands (matched by
  // content on the freshest user turn), so the user never sees it twice.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const showOptimistic =
    optimisticUser !== null && lastUser?.content !== optimisticUser;

  // Keep the newest turn in view as messages / tokens land.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming.content, showOptimistic, isStreaming]);

  const chatLocale = locale === "de" ? "de" : "en";

  const submit = () => {
    const message = draft.trim();
    if (!message || isStreaming) return;
    setDraft("");
    void send({ conversationId, message, locale: chatLocale });
  };

  const handleOpenChange = (next: boolean) => {
    // Closing discards the live stream state (the persisted history stays on
    // disk and reloads next open) — mirrors the Coach drawer's reset-on-close.
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side={isPhoneViewport ? "bottom" : "right"}
        showCloseButton={false}
        data-slot="document-chat-drawer"
        data-variant={isPhoneViewport ? "bottom-sheet" : "side-sheet"}
        className={cn(
          "w-full p-0 sm:max-w-[720px]",
          "lg:!max-w-[min(960px,75vw)] xl:!max-w-[1080px]",
          isPhoneViewport
            ? "flex h-[90dvh] max-h-[90dvh] flex-col gap-0 rounded-t-2xl"
            : "flex h-[100dvh] flex-col gap-0",
        )}
      >
        {/* Header: the accessible name + description stay mounted for Radix; the
            visible line is the quiet scope badge + the close control. */}
        <div className="border-border/70 flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0 flex-1">
            <SheetTitle className="sr-only">
              {t("documents.chat.title")}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t("documents.chat.safety")}
            </SheetDescription>
            <span
              data-slot="document-chat-scope"
              className={cn(
                "border-border/60 bg-muted/40 text-muted-foreground",
                "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1",
                "text-xs font-medium",
              )}
            >
              <FileText
                className="text-muted-foreground size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="truncate">
                {t("documents.chat.scopeBadge", { title: documentTitle })}
              </span>
            </span>
          </div>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-slot="document-chat-drawer-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>

        <div
          data-slot="document-chat-body"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
        >
          {indexed ? (
            <DocumentChatConversation
              messages={messages}
              optimisticContent={showOptimistic ? optimisticUser : null}
              streamingContent={streaming.content}
              isStreaming={isStreaming}
              streamErrorKey={
                streaming.errorCode
                  ? documentChatErrorKey(streaming.errorCode)
                  : null
              }
              historyPending={thread.isPending}
              historyError={thread.isError}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submit}
              onClose={() => handleOpenChange(false)}
              logRef={logRef}
            />
          ) : (
            // Not indexed: a calm pointer to read it with AI first (never an
            // error) — the drawer opens, it just has nothing to ground on yet.
            <div
              data-slot="document-chat"
              className="border-border/60 space-y-2 border-t pt-3"
            >
              <p className="text-sm font-semibold">
                {t("documents.chat.title")}
              </p>
              <p
                data-slot="document-chat-not-indexed"
                className="text-muted-foreground text-xs"
              >
                {t("documents.chat.notIndexed")}
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
