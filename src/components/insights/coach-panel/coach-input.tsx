"use client";

import { type FormEvent, type KeyboardEvent, useCallback } from "react";
import { Loader2, Mic, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B2b — Coach composer.
 *
 * `<textarea>` wrapped in a Dracula-styled card with a send button +
 * mic placeholder. Submit fires on:
 *   - Enter (no Shift) → send
 *   - Cmd/Ctrl + Enter → send (parity with the artboard ⌘↵ chip)
 *   - Shift + Enter → newline (default browser behaviour)
 *
 * The composer is purely controlled — `value` + `onChange` come from
 * the drawer. `disabled` flips during a streamed reply so we never
 * fire two requests in parallel.
 *
 * Mic is rendered but disabled with a tooltip ("Voice input arrives
 * with the iOS app in v1.5") because the natural shipper of voice is
 * the native client, not the PWA.
 *
 * The disclaimer below the input is a hard requirement — Coach
 * replies are not medical advice.
 */
export interface CoachInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** Disabled while a previous reply is still streaming. */
  disabled?: boolean;
  /** Surfaces the streaming-in-progress affordance on the send button. */
  isStreaming?: boolean;
  /** Optional textarea ref so the parent can focus on drawer open. */
  inputId?: string;
}

export function CoachInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  isStreaming = false,
  inputId = "coach-composer-textarea",
}: CoachInputProps) {
  const { t } = useTranslations();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      // Shift+Enter inserts a newline.
      if (event.shiftKey) return;
      // Plain Enter and ⌘/Ctrl+Enter both submit.
      event.preventDefault();
      if (!disabled && value.trim().length > 0) {
        onSubmit();
      }
    },
    [disabled, onSubmit, value],
  );

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!disabled && value.trim().length > 0) {
        onSubmit();
      }
    },
    [disabled, onSubmit, value],
  );

  const canSubmit = !disabled && value.trim().length > 0;

  return (
    <form
      data-slot="coach-input"
      onSubmit={handleFormSubmit}
      className="flex flex-col gap-2"
    >
      <div
        className={cn(
          "border-border/60 bg-muted/40 group rounded-md border",
          "p-2.5 transition-colors",
          "focus-within:border-dracula-purple/50 focus-within:ring-dracula-purple/15 focus-within:ring-2",
        )}
      >
        <textarea
          id={inputId}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("insights.coach.composerPlaceholder")}
          disabled={disabled}
          rows={2}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-relaxed outline-none",
            "placeholder:text-muted-foreground disabled:opacity-60",
          )}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled
                  aria-label={t("insights.coach.voiceComingSoon")}
                  data-slot="coach-input-mic"
                  className="size-8"
                >
                  <Mic className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("insights.coach.voiceComingSoon")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span
            data-slot="coach-input-hint"
            className="text-muted-foreground text-[11px]"
          >
            {t("insights.coach.composerHint")}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            data-slot="coach-input-send"
            className="ml-auto gap-1.5"
          >
            {isStreaming ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-3.5" aria-hidden="true" />
            )}
            <span>{t("insights.coach.send")}</span>
          </Button>
        </div>
      </div>
      <p
        data-slot="coach-input-disclaimer"
        className="text-muted-foreground text-[11px]"
      >
        {t("insights.coach.composerDisclaimer")}
      </p>
    </form>
  );
}
