"use client";

import { useEffect, useState } from "react";
import { Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachInput } from "./coach-input";
import { CoachSettingsSheet } from "./coach-settings-sheet";
import { HistoryRail } from "./history-rail";
import { MessageThread } from "./message-thread";
import { MobileRailTray } from "./mobile-rail-tray";
import { SourcesRail } from "./sources-rail";
import { useResettableValue } from "./use-resettable-value";
import { useCoachConversation, useSendCoachMessage } from "./use-coach";

/**
 * v1.12.0 (Coach v2 #6) — shared chat surface for both the Coach drawer
 * (`<CoachDrawer>`, right/bottom `<Sheet>` overlay) and the full-page
 * Coach route (`/insights/coach`).
 *
 * This component is the single source of truth for the Coach
 * conversation: it owns the active-conversation id, the streaming send
 * hook, the composer value, the settings sheet, and the mobile rail
 * trays — every piece of Coach v2 behaviour (incremental streaming,
 * collapsible history + provenance, the single composer disclaimer,
 * the auto-grow composer, refusal / budget handling) lives here once.
 * The drawer and the page differ ONLY in their chrome: the drawer wraps
 * this surface in a `<Sheet>` and supplies a close button + a maximize
 * control; the page renders it edge-to-edge and supplies a minimize
 * control. Neither forks the chat logic.
 *
 * The title + description render through `renderTitle` / `renderDescription`
 * render-props so the drawer can mount the Radix `<SheetTitle>` /
 * `<SheetDescription>` (required for the dialog's accessible name) while
 * the page mounts a plain `<h1>` / `<p>`.
 */
export interface CoachConversationProps {
  /**
   * Pre-fill for the composer (suggested-prompt chip click). Resets the
   * composer on change via `useResettableValue`; the user can still type
   * freely between prop changes.
   */
  prefill?: string | null;
  /**
   * Renders the conversation title. The surface passes the resolved
   * title string; the drawer wraps it in `<SheetTitle>`, the page in an
   * `<h1>`. Falls back to a plain element when omitted.
   */
  renderTitle?: (title: string) => React.ReactNode;
  /** Renders the tagline line beneath the title (see `renderTitle`). */
  renderDescription?: (tagline: string) => React.ReactNode;
  /**
   * Chrome-specific header action(s) — the maximize control (drawer) or
   * the minimize control (page) — mounted before the avatar so the
   * surface-toggle sits at the leading edge of the header.
   */
  leadingHeaderActions?: React.ReactNode;
  /**
   * Chrome-specific trailing control — the drawer's close button. The
   * page leaves this empty (it has no close affordance of its own).
   */
  trailingHeaderActions?: React.ReactNode;
  /**
   * Focus the composer on mount. The drawer sets this so the composer
   * takes focus when the sheet opens; the page sets it so a keyboard
   * user lands in the composer after the route change.
   */
  autoFocusComposer?: boolean;
  /**
   * Hands the chrome an imperative reset (abort any in-flight SSE +
   * clear the thread + composer). The drawer wires this to its close
   * handler so closing the overlay does not leave a stream running. The
   * page omits it — navigating away unmounts the whole subtree, which
   * tears the stream down on its own.
   */
  registerReset?: (reset: () => void) => void;
  /** className passthrough for the outer flex column. */
  className?: string;
  /** data-variant on the root, surfaced for e2e + styling hooks. */
  surface: "drawer" | "page";
}

export function CoachConversation({
  prefill,
  renderTitle,
  renderDescription,
  leadingHeaderActions,
  trailingHeaderActions,
  autoFocusComposer,
  registerReset,
  className,
  surface,
}: CoachConversationProps) {
  const { t } = useTranslations();

  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  const [historyTrayOpen, setHistoryTrayOpen] = useState(false);
  const [sourcesTrayOpen, setSourcesTrayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inputValue, setInputValue] = useResettableValue(prefill ?? "");

  const { data: conversation } = useCoachConversation(currentConversationId);
  const send = useSendCoachMessage({
    onDone: (resolvedId) => {
      setCurrentConversationId(resolvedId);
    },
  });

  // Hand the chrome an imperative reset so the drawer can abort the
  // in-flight SSE stream + clear the thread on close. Re-registered when
  // the closed-over state setters / send hook change identity so the
  // callback never captures a stale conversation id.
  useEffect(() => {
    if (!registerReset) return;
    registerReset(() => {
      send.cancel();
      setCurrentConversationId(null);
      setInputValue("");
    });
  }, [registerReset, send, setInputValue]);

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || send.isStreaming) return;
    setInputValue("");
    await send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
    });
  }

  function handleNewChat() {
    setCurrentConversationId(null);
    setInputValue("");
    send.reset();
  }

  const title = conversation?.title ?? t("insights.coach.newChat");
  const tagline = t("insights.coach.tagline");

  return (
    <div
      data-slot="coach-conversation"
      data-variant={surface}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <header
        data-slot="coach-conversation-header"
        className="border-border/70 flex flex-row items-center gap-2 border-b p-3 sm:gap-3 sm:p-4"
      >
        {leadingHeaderActions}
        <div
          aria-hidden="true"
          className="from-dracula-purple to-dracula-pink flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {renderTitle ? (
            renderTitle(title)
          ) : (
            <p className="min-w-0 truncate text-sm font-semibold">{title}</p>
          )}
          {renderDescription ? (
            renderDescription(tagline)
          ) : (
            <p className="text-muted-foreground truncate text-[11px]">
              {tagline}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleNewChat}
          data-slot="coach-new-chat"
          aria-label={t("insights.coach.newChat")}
          title={t("insights.coach.newChat")}
          className="text-muted-foreground hover:text-foreground size-11 shrink-0"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setSettingsOpen(true)}
          data-slot="coach-settings"
          aria-label={t("insights.coach.settingsAriaLabel")}
          title={t("insights.coach.settingsAriaLabel")}
          className="text-muted-foreground hover:text-foreground size-11 shrink-0"
        >
          <Settings className="size-4" aria-hidden="true" />
        </Button>
        {trailingHeaderActions}
      </header>

      <CoachDrawerBody
        sourcesRail={<SourcesRail />}
        thread={
          <MessageThread
            conversation={conversation ?? null}
            streaming={send.streaming}
            optimisticUser={send.optimisticUser}
          />
        }
        disclaimer={
          <p
            data-slot="coach-composer-disclaimer"
            className="text-muted-foreground text-xs leading-relaxed"
          >
            {t("insights.coach.composerDisclaimer")}
          </p>
        }
        composer={
          <CoachInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={() => handleSubmit(inputValue)}
            onCancel={send.cancel}
            disabled={send.isStreaming}
            isStreaming={send.isStreaming}
            autoFocusOnOpen={autoFocusComposer}
          />
        }
        onOpenHistoryTray={() => setHistoryTrayOpen(true)}
        onOpenSourcesTray={() => setSourcesTrayOpen(true)}
      />

      <CoachSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <MobileRailTray
        historyOpen={historyTrayOpen}
        onHistoryOpenChange={setHistoryTrayOpen}
        historyRail={
          <HistoryRail
            activeId={currentConversationId}
            onSelect={(id) => {
              setCurrentConversationId(id);
              setHistoryTrayOpen(false);
            }}
          />
        }
        sourcesOpen={sourcesTrayOpen}
        onSourcesOpenChange={setSourcesTrayOpen}
        sourcesRail={<SourcesRail />}
      />
    </div>
  );
}
