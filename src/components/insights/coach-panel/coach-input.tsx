"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Loader2, Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B2b — Coach composer.
 *
 * `<textarea>` wrapped in a Dracula-styled card with a send button.
 * Submit fires on:
 *   - Enter (no Shift) → send
 *   - Cmd/Ctrl + Enter → send (parity with the artboard ⌘↵ chip)
 *   - Shift + Enter → newline (default browser behaviour)
 *
 * The composer is purely controlled — `value` + `onChange` come from
 * the drawer. `disabled` flips during a streamed reply so we never
 * fire two requests in parallel.
 *
 * v1.4.22 B4: the disclaimer ("Coach replies are generated …") moved
 * out of the composer and into the sources rail footer, so the
 * composer stays focused on the input affordance.
 *
 * v1.4.25 W5: dropped the non-functional mic icon. The voice-input
 * affordance ships with the iOS client; surfacing a placeholder in the
 * web composer drew clicks for an action that did nothing.
 */
export interface CoachInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /**
   * Aborts the in-flight streamed reply. The composer swaps the send
   * button for a Stop control while `isStreaming` is set; tapping it
   * cancels the SSE request so the user can interrupt a long or
   * off-track reply.
   */
  onCancel?: () => void;
  /** Disabled while a previous reply is still streaming. */
  disabled?: boolean;
  /** Surfaces the streaming-in-progress affordance on the send button. */
  isStreaming?: boolean;
  /** Optional textarea ref so the parent can focus on drawer open. */
  inputId?: string;
  /**
   * v1.4.27 MB3 / CF-30 — when set, focuses the composer textarea once
   * on mount. The drawer flips this to `true` when the drawer becomes
   * the freshly-opened surface so the user can start typing
   * immediately. It must stay opt-in (lazy): on every re-render of an
   * already-open drawer we do not steal focus back.
   */
  autoFocusOnOpen?: boolean;
}

/**
 * v1.4.25 W5 — Claude-web-style auto-grow.
 *
 * The composer textarea starts at 1 line (≈44 px including padding,
 * matching the disclaimer text height on the sources rail) and grows
 * with content up to 6 lines (≈144 px). Past 6 lines the textarea
 * scrolls internally. Implemented as a plain `scrollHeight` measurement
 * — no external auto-resize library, no `contenteditable` round-trip,
 * no `field-sizing` (still Chrome-only in 2026-Q2).
 *
 * Pure helper so the math can be unit-tested without a DOM:
 *   - `lineHeight`: cached line-height of the textarea (px)
 *   - `scrollHeight`: textarea's natural `scrollHeight` after height
 *     was reset to "auto"
 *   - `maxLines`: hard cap (6); past this the textarea scrolls
 * Returns the height in px to apply, clamped to [minHeight, maxHeight].
 */
export function computeAutoGrowHeight(args: {
  lineHeight: number;
  scrollHeight: number;
  maxLines: number;
  paddingY: number;
}): number {
  const min = args.lineHeight + args.paddingY;
  const max = args.lineHeight * args.maxLines + args.paddingY;
  // Honour the existing scrollHeight (which already includes padding)
  // but clamp it into the [min,max] band. The minimum guarantees the
  // textarea never collapses below a single line when the value is
  // empty; the maximum prevents the row from pushing the composer
  // taller than 6 lines.
  return Math.max(min, Math.min(args.scrollHeight, max));
}

const AUTO_GROW_MAX_LINES = 6;

export function CoachInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
  isStreaming = false,
  inputId = "coach-composer-textarea",
  autoFocusOnOpen = false,
}: CoachInputProps) {
  const { t } = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // v1.4.27 MB3 / CF-30 — focus the textarea once on mount when the
  // parent flags this surface as the freshly-opened one. The empty
  // dependency array keeps this from re-firing on every value change
  // (the auto-grow effect handles those). We bail when disabled so we
  // do not yank focus into a non-interactive field.
  useEffect(() => {
    if (!autoFocusOnOpen || disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    // Defer to the next paint so the drawer's own focus-trap finishes
    // resolving before we hand the cursor to the composer.
    const id = window.requestAnimationFrame(() => {
      el.focus();
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);

  // v1.4.25 W5 — auto-grow side effect. Runs on every value change
  // (the controlled `value` prop is the source of truth) plus on mount
  // so the initial paint already shows the 1-line height even when the
  // value arrives prefilled. We reset `style.height` to "auto" first so
  // shrinking text (e.g. after the user hits send) also collapses the
  // textarea — without the reset, `scrollHeight` only ever monotonically
  // grows. Reads `getComputedStyle` for line-height + padding once per
  // tick so a CSS-only theme change re-applies the right minimum.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset so the browser re-measures the natural content height.
    el.style.height = "auto";
    const computed = window.getComputedStyle(el);
    const rawLineHeight = parseFloat(computed.lineHeight);
    const lineHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : 20;
    const paddingY =
      (parseFloat(computed.paddingTop) || 0) +
      (parseFloat(computed.paddingBottom) || 0);
    const height = computeAutoGrowHeight({
      lineHeight,
      scrollHeight: el.scrollHeight,
      maxLines: AUTO_GROW_MAX_LINES,
      paddingY,
    });
    el.style.height = `${height}px`;
  }, [value]);

  const canSubmit = !disabled && value.trim().length > 0;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Enter inserts a newline; plain Enter and ⌘/Ctrl+Enter submit.
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (canSubmit) onSubmit();
    },
    [canSubmit, onSubmit],
  );

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (canSubmit) onSubmit();
    },
    [canSubmit, onSubmit],
  );

  return (
    <form
      data-slot="coach-input"
      onSubmit={handleFormSubmit}
      className="flex flex-col"
    >
      {/* v1.16.1 — modern chat-app composer: a single row with the
          textarea and the send control on the same baseline. The
          textarea starts at one line and auto-grows; `items-end` keeps
          the button pinned to the input's last line as it grows. The
          old footer row (Info-popover hint + right-aligned button) is
          gone — Enter still sends and Shift+Enter still inserts a
          newline, the affordance just no longer needs explaining. */}
      <div
        className={cn(
          "border-border/60 bg-muted/40 group rounded-md border",
          "flex items-end gap-2 p-2 transition-colors",
          "focus-within:border-dracula-purple/50 focus-within:ring-dracula-purple/15 focus-within:ring-2",
        )}
      >
        <textarea
          id={inputId}
          ref={textareaRef}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("insights.coach.composerPlaceholder")}
          disabled={disabled}
          // v1.4.27 MB3 / CF-30 — surface the "send" virtual-keyboard
          // return on iOS / Android instead of the generic newline
          // glyph, and lift autocapitalize to "sentences" so a
          // question typed on phone reads as one. The submit handler
          // still preserves Shift+Enter for explicit newlines.
          enterKeyHint="send"
          autoCapitalize="sentences"
          // v1.4.25 W5 — single-line initial state, Claude-web-style.
          // `rows={1}` is the SSR-stable baseline; the `useEffect`
          // above grows the textarea up to `AUTO_GROW_MAX_LINES`. Past
          // the cap the textarea scrolls internally (overflow-auto via
          // `max-h-[9.5rem]`, ≈6 lines at the current line-height).
          rows={1}
          className={cn(
            // `text-base` (16 px) on mobile so iOS Safari does not
            // zoom-on-focus — the kerned `text-sm` (14 px) trips the
            // 16 px floor and yanks the viewport on every Coach tap.
            // Desktop shrinks back to `text-sm` for the compact
            // composer.
            "min-w-0 flex-1 resize-none bg-transparent text-base leading-relaxed outline-none sm:text-sm",
            // Centre the single-line state against the 36 px send
            // button so the placeholder and the icon share a baseline.
            "py-1.5",
            "max-h-[9.5rem] overflow-auto",
            "placeholder:text-muted-foreground disabled:opacity-60",
          )}
        />
        {isStreaming && onCancel ? (
          // While a reply streams, swap the send button for a Stop
          // control bound to the abort handler so the user can
          // interrupt a long or off-track reply instead of waiting it
          // out.
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={onCancel}
            data-slot="coach-input-stop"
            aria-label={t("insights.coach.stop")}
            title={t("insights.coach.stop")}
            className="size-9 shrink-0"
          >
            <Square className="size-3.5 fill-current" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!canSubmit}
            data-slot="coach-input-send"
            aria-label={t("insights.coach.send")}
            title={t("insights.coach.send")}
            className="size-9 shrink-0"
          >
            {isStreaming ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
