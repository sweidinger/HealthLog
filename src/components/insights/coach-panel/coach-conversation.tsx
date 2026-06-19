"use client";

import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";

import { CoachDrawerBody } from "./coach-drawer-body";
import { CoachInput } from "./coach-input";
import {
  GuidedQuestionBubble,
  GuidedSummaryBubble,
} from "./guided-dialog-bubbles";
import { GuidedQuestionsCard } from "./guided-questions-card";
import {
  deriveThreadItems,
  GUIDED_IDLE,
  guidedReducer,
} from "./guided-questions-machine";
import { HistoryRail } from "./history-rail";
import { MessageThread, type InterleavedThreadItem } from "./message-thread";
import { MobileRailTray } from "./mobile-rail-tray";
import { SelfContextAdoptOffer } from "./self-context-adopt-offer";
import { SourcesRail } from "./sources-rail";
import { useResettableValue } from "./use-resettable-value";
import { useCoachConversation, useSendCoachMessage } from "./use-coach";

/**
 * v1.12.0 (Coach v2 #6) — shared chat surface for both the Coach drawer
 * (`<CoachDrawer>`, right/bottom `<Sheet>` overlay) and the full-page
 * Coach route (`/coach`).
 *
 * This component is the single source of truth for the Coach
 * conversation: it owns the active-conversation id, the streaming send
 * hook, the composer value, and the rail trays — every piece of Coach
 * v2 behaviour (incremental streaming, collapsible history +
 * provenance, the auto-grow composer, refusal / budget handling)
 * lives here once.
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
  /**
   * v1.16.1 — drawer-only: the "Conversations" affordance no longer
   * opens an in-panel left tray (it kept breaking inside the sheet);
   * it hands the user off to the full-page Coach route instead. The
   * drawer wires this to its maximize handler (close sheet + route);
   * the page omits it and renders the list inline / as a tray.
   */
  onRequestFullView?: () => void;
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
  onRequestFullView,
  className,
  surface,
}: CoachConversationProps) {
  const { t } = useTranslations();

  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  const [historyTrayOpen, setHistoryTrayOpen] = useState(false);
  const [sourcesTrayOpen, setSourcesTrayOpen] = useState(false);
  // v1.18.7 (W-coach C-UI) — page surface only: the inline conversation
  // rail is collapsed by default for a calm, prompt-first surface. The
  // rail-tray-strip toggle (lg+) opens it; the rail heading closes it.
  const [historyRailOpen, setHistoryRailOpen] = useState(false);
  const [inputValue, setInputValue] = useResettableValue(prefill ?? "");
  // v1.16.4 — self-context backflow: `pendingAdopt` raises a quiet
  // offer to fold a clarifying-question answer back into the
  // Selbstauskunft. v1.16.5 — the answers now come from the guided
  // flow; `guidedIndex` routes the offer's outcome back into the
  // machine so the closing summary can say what was adopted.
  const [pendingAdopt, setPendingAdopt] = useState<{
    question: string;
    answer: string;
    guidedIndex: number;
  } | null>(null);

  // v1.16.5 — guided clarifying-questions flow (V2 of the v1.16.0
  // chips). The machine is pure (`guided-questions-machine.ts`); this
  // component owns the server round-trips: the pending-questions query
  // feeding the entry card, the per-question dismiss on answer, and
  // the dismiss-all behind "don't ask again".
  const [guided, dispatchGuided] = useReducer(guidedReducer, GUIDED_IDLE);
  const queryClient = useQueryClient();
  const { data: questionsData } = useQuery({
    queryKey: queryKeys.coachAboutMeQuestions(),
    queryFn: async () =>
      apiGet<{ questions: string[] }>("/api/coach/about-me/questions"),
    staleTime: 60_000,
  });
  const pendingQuestions = questionsData?.questions ?? [];
  const dismissQuestions = useMutation({
    mutationKey: queryKeys.coachAboutMeQuestions(),
    mutationFn: async (question?: string) =>
      apiDelete<{ questions: string[] }>(
        "/api/coach/about-me/questions",
        question === undefined ? {} : { question },
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.coachAboutMeQuestions(), next);
    },
    onError: () => {
      toast.error(t("insights.coach.guided.dismissError"));
    },
  });

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
      setPendingAdopt(null);
      dispatchGuided({ type: "RESET" });
    });
  }, [registerReset, send, setInputValue]);

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || send.isStreaming) return;
    // v1.16.5 — in the guided flow the composer message IS the answer
    // to the current question. Mark it answered before the send so the
    // question bubble anchors above the user's message, and dismiss the
    // question server-side — answered questions never return.
    const guidedQuestion =
      guided.phase === "asking" ? guided.questions[guided.index] : null;
    const guidedIndex = guided.phase === "asking" ? guided.index : null;
    if (guidedQuestion !== null) {
      dispatchGuided({ type: "ANSWER_SUBMITTED", answer: trimmed });
      dismissQuestions.mutate(guidedQuestion);
    }
    setInputValue("");
    // v1.16.6 — hand the question to the turn so the Coach reaction is
    // contextual (the question bubble itself is never persisted).
    const resolvedId = await send.send({
      conversationId: currentConversationId ?? undefined,
      message: trimmed,
      guidedQuestion: guidedQuestion ?? undefined,
    });
    if (guidedQuestion !== null && guidedIndex !== null) {
      setPendingAdopt({
        question: guidedQuestion,
        answer: trimmed,
        guidedIndex,
      });
      // v1.16.6 — sequence per answer: answer → Coach reaction
      // (streamed above) → adopt offer → next question. A resolved id
      // means the reaction landed; the machine then advances when the
      // adopt offer settles (ADOPTION_SETTLED). A null id is the
      // provider-less / errored turn — no reaction is coming, so keep
      // the original silent flow and advance immediately.
      if (resolvedId === null) {
        dispatchGuided({ type: "TURN_COMPLETE" });
      }
    }
  }

  function handleNewChat() {
    setCurrentConversationId(null);
    setInputValue("");
    setPendingAdopt(null);
    dispatchGuided({ type: "RESET" });
    send.reset();
  }

  const title = conversation?.title ?? t("insights.coach.newChat");
  const tagline = t("insights.coach.tagline");

  // v1.16.5 — materialise the machine's thread items into bubbles. The
  // thread only places them (`placeInterleaved`); every behaviour stays
  // here with the flow.
  const interleaved: InterleavedThreadItem[] = deriveThreadItems(guided).map(
    (item) => ({
      key: item.key,
      anchorAnswer: item.anchorAnswer,
      node:
        item.kind === "summary" ? (
          <GuidedSummaryBubble
            answered={item.summary?.answered ?? 0}
            adopted={item.summary?.adopted ?? 0}
            total={item.summary?.total ?? 0}
          />
        ) : (
          <GuidedQuestionBubble
            question={item.question ?? ""}
            progress={item.progress ?? { current: 1, total: 1 }}
            current={item.current}
            actionsDisabled={send.isStreaming || dismissQuestions.isPending}
            onSkip={
              item.current ? () => dispatchGuided({ type: "SKIP" }) : undefined
            }
            onLater={
              item.current ? () => dispatchGuided({ type: "EXIT" }) : undefined
            }
            onDismissRemaining={
              item.current
                ? () =>
                    dismissQuestions.mutate(undefined, {
                      onSuccess: () => dispatchGuided({ type: "EXIT" }),
                    })
                : undefined
            }
          />
        ),
    }),
  );

  return (
    <div
      data-slot="coach-conversation"
      data-variant={surface}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <header
        data-slot="coach-conversation-header"
        // v1.18.1 (W-COACH-UI C2/C4) — the header used to crowd a bare
        // leading ghost-icon flush against the avatar (the "minimal"
        // element the maintainer disliked). The surface-toggle now sits
        // in its own leading cluster separated by a hairline divider, the
        // avatar steps up to `size-9`, and the band locks to `h-14` so
        // its bottom border shares the horizontal line with the body's
        // rail-tray strip + history-rail heading one row below.
        className="border-border/70 flex h-14 shrink-0 flex-row items-center gap-2.5 border-b px-3 sm:px-4"
      >
        {leadingHeaderActions ? (
          <div className="border-border/60 -ml-1 flex items-center gap-1 pr-1 sm:border-r sm:pr-2.5">
            {leadingHeaderActions}
          </div>
        ) : null}
        <div
          aria-hidden="true"
          className="from-dracula-purple to-dracula-pink flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br shadow-sm"
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
        {/* v1.16.1 — the Coach preferences moved into Settings → AI
            (one place for model + behaviour). The header keeps a gear
            that deep-links there instead of opening an in-chat sheet. */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          data-slot="coach-settings"
          className="text-muted-foreground hover:text-foreground size-11 shrink-0"
        >
          <Link
            href="/settings/ai"
            aria-label={t("insights.coach.settingsAriaLabel")}
            title={t("insights.coach.settingsAriaLabel")}
          >
            <Settings className="size-4" aria-hidden="true" />
          </Link>
        </Button>
        {trailingHeaderActions}
      </header>

      <CoachDrawerBody
        historyOpen={historyRailOpen}
        onToggleHistory={
          surface === "page"
            ? () => setHistoryRailOpen((open) => !open)
            : undefined
        }
        historyRail={
          surface === "page" ? (
            <HistoryRail
              activeId={currentConversationId}
              // v1.18.1 — the `<aside>` band already renders the
              // "Conversations" <h2>; suppress the rail's own <h3> so the
              // heading is not stacked twice on the page surface.
              hideHeading
              onSelect={(id) => {
                // v1.16.5 — switching conversations drops the guided
                // session; unanswered questions stay pending.
                setCurrentConversationId(id);
                setPendingAdopt(null);
                dispatchGuided({ type: "RESET" });
              }}
            />
          ) : undefined
        }
        thread={
          <MessageThread
            conversation={conversation ?? null}
            streaming={send.streaming}
            optimisticUser={send.optimisticUser}
            interleaved={interleaved}
          />
        }
        composer={
          <div>
            {/* v1.16.4 — quiet adopt-into-self-context offer once a
                clarifying question has been answered. Self-removes
                after settle; v1.16.5 reports the outcome back into the
                guided machine for the closing summary. */}
            {pendingAdopt && !send.isStreaming ? (
              <SelfContextAdoptOffer
                question={pendingAdopt.question}
                answer={pendingAdopt.answer}
                onDismiss={() => setPendingAdopt(null)}
                onSettled={(adoption) =>
                  dispatchGuided({
                    type: "ADOPTION_SETTLED",
                    index: pendingAdopt.guidedIndex,
                    adoption,
                  })
                }
              />
            ) : null}
            {/* v1.16.5 — guided clarifying-questions entry card (V2 of
                the v1.16.0 chips). Offers the in-chat sequence while
                questions pend and the flow hasn't started. */}
            {guided.phase === "idle" && pendingQuestions.length > 0 ? (
              <GuidedQuestionsCard
                count={pendingQuestions.length}
                disabled={send.isStreaming || dismissQuestions.isPending}
                onStart={() =>
                  dispatchGuided({ type: "START", questions: pendingQuestions })
                }
                onLater={() => dispatchGuided({ type: "LATER" })}
                onDismissAll={() =>
                  dismissQuestions.mutate(undefined, {
                    onSuccess: () => dispatchGuided({ type: "LATER" }),
                  })
                }
              />
            ) : null}
            <CoachInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={() => handleSubmit(inputValue)}
              onCancel={send.cancel}
              disabled={send.isStreaming}
              isStreaming={send.isStreaming}
              autoFocusOnOpen={autoFocusComposer}
              placeholder={
                guided.phase === "asking"
                  ? t("insights.coach.guided.answerPlaceholder")
                  : undefined
              }
            />
          </div>
        }
        onHistoryClick={
          surface === "drawer" && onRequestFullView
            ? onRequestFullView
            : () => setHistoryTrayOpen(true)
        }
        onOpenSourcesTray={() => setSourcesTrayOpen(true)}
      />

      <MobileRailTray
        historyOpen={historyTrayOpen}
        onHistoryOpenChange={setHistoryTrayOpen}
        historyRail={
          <HistoryRail
            activeId={currentConversationId}
            onSelect={(id) => {
              setCurrentConversationId(id);
              setHistoryTrayOpen(false);
              setPendingAdopt(null);
              dispatchGuided({ type: "RESET" });
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
