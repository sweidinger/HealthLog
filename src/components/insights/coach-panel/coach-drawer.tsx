"use client";

import { useCallback, useState } from "react";
import { Plus, Settings2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachInput } from "./coach-input";
import { HistoryRail } from "./history-rail";
import { MessageThread } from "./message-thread";
import { SourcesRail } from "./sources-rail";
import {
  useCoachConversation,
  useSendCoachMessage,
} from "./use-coach";

/**
 * v1.4.20 phase B2b — AI Coach drawer (right-side `<Sheet>` overlay).
 *
 * Mounts above `/insights` so the user keeps the dashboard context
 * behind it. Single-column on `<lg`; on desktop the history rail and
 * sources rail mount alongside the message thread (delivered in
 * commit 3, this file lays out the slots).
 *
 * The drawer is fully-controlled by the parent (`open` /
 * `onOpenChange`). The `prefill` prop lets the hero strip's
 * suggested-prompt chips pre-populate the input on open.
 *
 * History rail + sources rail import-load asynchronously to keep the
 * drawer's first-paint cheap. Until commit 3 lands, those slots
 * render as visual placeholders that match the column widths.
 */
export interface CoachDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Optional pre-fill for the input box (suggested-prompt chip click). */
  prefill?: string | null;
  /**
   * Optional rail slots — passed by the parent so commit-3 can mount
   * the history + sources rails without coupling them to the drawer
   * shell. Falls through to a no-op when omitted.
   */
  historyRail?: React.ReactNode;
  sourcesRail?: React.ReactNode;
  /**
   * Composer slot — the parent wires `<CoachInput>` here in commit 3
   * so this shell stays presentational. The shell renders its own
   * minimal input fallback when no slot is supplied (used during the
   * commit-2 boundary to keep the drawer functional in isolation).
   */
  composer?: React.ReactNode;
}

export function CoachDrawer({
  open,
  onOpenChange,
  prefill,
  historyRail,
  sourcesRail,
  composer,
}: CoachDrawerProps) {
  const { t } = useTranslations();

  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  // v1.4.20 phase B4 — mobile rail trays. The history + sources rails
  // are hidden on `<lg` from B2b; the chevron buttons below toggle them
  // as side-sheets so the user can browse conversations + see what
  // data the Coach is using without losing the message thread context.
  const [historyTrayOpen, setHistoryTrayOpen] = useState(false);
  const [sourcesTrayOpen, setSourcesTrayOpen] = useState(false);
  // The composer's input value is seeded from `prefill` whenever the
  // parent toggles `open` — we mount the drawer with a key derived from
  // (open, prefill) so the lazy initialiser fires fresh on each
  // open/prefill transition. That sidesteps `setState`-in-`useEffect`
  // entirely (banned by `react-hooks/set-state-in-effect`).
  const [inputValue, setInputValue] = useState<string>(() => prefill ?? "");

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset thread + composer on close so the next open starts on
        // the rail's empty hint instead of re-rendering the previous
        // conversation by accident.
        setCurrentConversationId(null);
        setInputValue("");
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const { data: conversation } = useCoachConversation(currentConversationId);
  const send = useSendCoachMessage({
    onDone: (resolvedId) => {
      setCurrentConversationId(resolvedId);
    },
  });

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

  const drawerTitle = conversation?.title ?? t("insights.coach.newChat");

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        data-slot="coach-drawer"
        className={cn(
          "w-full p-0 sm:max-w-[720px] lg:max-w-[1080px]",
          "flex h-[100dvh] flex-col gap-0",
        )}
      >
        {/* Header (full width). Title + new-chat button + settings. */}
        <SheetHeader
          data-slot="coach-drawer-header"
          className="border-border/70 flex-row items-center gap-3 border-b p-3 sm:p-4"
        >
          <div
            aria-hidden="true"
            className="from-dracula-purple to-dracula-pink flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
          >
            <Sparkles className="text-background size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-sm font-semibold">
              {drawerTitle}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground truncate text-[11px]">
              {t("insights.coach.tagline")}
            </SheetDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleNewChat}
            data-slot="coach-drawer-new-chat"
            className="gap-1.5"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">
              {t("insights.coach.newChat")}
            </span>
          </Button>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled
                  aria-label={t("insights.coach.settings")}
                  data-slot="coach-drawer-settings"
                  className="size-8"
                >
                  <Settings2 className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("insights.coach.settingsTooltip")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </SheetHeader>

        {/* Body — three columns on lg+, single column on smaller.
            The body slot is a separate component so the SSR test
            harness can pin the mobile rail-tray triggers without
            rendering the Sheet portal. */}
        <CoachDrawerBody
          historyRail={
            historyRail ?? (
              <HistoryRail
                activeId={currentConversationId}
                onSelect={(id) => setCurrentConversationId(id)}
              />
            )
          }
          sourcesRail={sourcesRail ?? <SourcesRail />}
          thread={
            <MessageThread
              conversation={conversation ?? null}
              streaming={send.streaming}
            />
          }
          composer={
            composer ?? (
              <CoachInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={() => handleSubmit(inputValue)}
                disabled={send.isStreaming}
                isStreaming={send.isStreaming}
              />
            )
          }
          onOpenHistoryTray={() => setHistoryTrayOpen(true)}
          onOpenSourcesTray={() => setSourcesTrayOpen(true)}
        />

        {/* v1.4.20 phase B4 — mobile-only rail trays. Each renders a
            slide-in panel from the matching edge and surfaces the same
            HistoryRail / SourcesRail instance the desktop layout uses,
            so a `>=lg` viewport never shows them but a `<lg` viewport
            can summon either rail without leaving the message thread. */}
        <Sheet open={historyTrayOpen} onOpenChange={setHistoryTrayOpen}>
          <SheetContent
            side="left"
            data-slot="coach-drawer-history-tray"
            className="w-[88vw] max-w-[320px] p-0 lg:hidden"
          >
            <SheetHeader className="border-border/70 border-b p-3">
              <SheetTitle className="text-sm">
                {t("insights.coach.historyTitle")}
              </SheetTitle>
            </SheetHeader>
            <div className="h-full min-h-0 overflow-y-auto">
              {historyRail ?? (
                <HistoryRail
                  activeId={currentConversationId}
                  onSelect={(id) => {
                    setCurrentConversationId(id);
                    setHistoryTrayOpen(false);
                  }}
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
        <Sheet open={sourcesTrayOpen} onOpenChange={setSourcesTrayOpen}>
          <SheetContent
            side="right"
            data-slot="coach-drawer-sources-tray"
            className="w-[88vw] max-w-[320px] p-0 lg:hidden"
          >
            <SheetHeader className="border-border/70 border-b p-3">
              <SheetTitle className="text-sm">
                {t("insights.coach.sourcesTitle")}
              </SheetTitle>
            </SheetHeader>
            <div className="h-full min-h-0 overflow-y-auto">
              {sourcesRail ?? <SourcesRail />}
            </div>
          </SheetContent>
        </Sheet>
      </SheetContent>
    </Sheet>
  );
}

