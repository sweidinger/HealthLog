"use client";

import { useEffect, useId, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.18.9 — the ONE Coach thinking indicator on the page surface.
 *
 * Replaces the old dots-plus-word combo (`<TypingDots>`), which showed
 * three bouncing dots AND the word "Thinking…" at the same time — the
 * exact pairing the maintainer disliked. This is a single, calm control:
 *
 *   - While the turn is thinking (streaming, no prose yet): a live
 *     "Thinking… N s" line with a small spinner. `role="status"` so a
 *     screen reader announces "thinking" once, not on every tick.
 *   - Once the first token lands OR the turn settles: it relabels to the
 *     past tense ("Thought for N s") and auto-collapses into a quiet
 *     `<details>` disclosure. Expanding reveals the reasoning summary when
 *     a reasoning-capable provider supplied one (the additive `reasoning`
 *     SSE frame), otherwise a one-line factual fallback — never fabricated
 *     chain-of-thought.
 *
 * The elapsed time is computed from the send-anchored `startedAt`
 * timestamp: it ticks live while thinking and freezes the instant the
 * first token (or the settled state) arrives.
 */
export interface ThinkingDisclosureProps {
  /**
   * Epoch-ms timestamp the turn started (the moment the send fired). Null
   * disables the elapsed timer (the component renders nothing).
   */
  startedAt: number | null;
  /** True until the turn settles (the `done`/`error` frame closed it). */
  inProgress: boolean;
  /**
   * Whether any assistant prose has streamed in yet. Drives the live →
   * past-tense relabel + auto-collapse: the moment the answer starts, the
   * "Thinking…" line freezes and folds away.
   */
  hasContent: boolean;
  /**
   * Optional reasoning-summary text from the additive `reasoning` SSE
   * frame, rendered inside the expanded disclosure when present.
   */
  reasoning?: string;
}

export function ThinkingDisclosure({
  startedAt,
  inProgress,
  hasContent,
  reasoning,
}: ThinkingDisclosureProps) {
  const { t } = useTranslations();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  // The turn is "thinking" only while it is in progress with no prose yet.
  const thinking = inProgress && hasContent === false && startedAt !== null;

  // `elapsed` ticks once a second while thinking; the interval stops the
  // moment `thinking` flips false, so the last value it set is the frozen
  // "thought for N s" figure — no render-time ref, no sync setState in the
  // effect body (the first tick lands on the interval, not inline).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!thinking || startedAt === null) return;
    const tick = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [thinking, startedAt]);

  if (startedAt === null) return null;

  // ── Live "thinking" line (single indicator, no dots-plus-word) ──
  if (thinking) {
    return (
      <div
        data-slot="coach-thinking-live"
        role="status"
        aria-live="polite"
        className="text-muted-foreground inline-flex items-center gap-2 py-0.5 text-xs"
      >
        <Loader2
          aria-hidden="true"
          className="text-dracula-purple/70 size-3.5 animate-spin motion-reduce:animate-none"
        />
        <span>{t("insights.coach.thinking")}</span>
        <span aria-hidden="true" className="tabular-nums opacity-70">
          {t("insights.coach.thinkingElapsed", { seconds: elapsed })}
        </span>
      </div>
    );
  }

  // ── Settled: past-tense collapsible disclosure (auto-collapsed) ──
  const reasoningText = reasoning?.trim() ?? "";
  return (
    <details
      data-slot="coach-thinking-disclosure"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="group inline-block"
    >
      <summary
        data-slot="coach-thinking-summary"
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={t("insights.coach.thinkingExpandAria")}
        className={cn(
          "text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-xs",
          "marker:hidden [&::-webkit-details-marker]:hidden",
          "focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-2",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-90"
        />
        <span>
          {t("insights.coach.thinkingDuration", { seconds: elapsed })}
        </span>
      </summary>
      <p
        id={panelId}
        data-slot="coach-thinking-detail"
        className="text-muted-foreground mt-1.5 pl-4 text-xs leading-relaxed"
      >
        {reasoningText || t("insights.coach.thinkingDetail")}
      </p>
    </details>
  );
}
