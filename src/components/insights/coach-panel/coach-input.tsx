"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  FolderOpen,
  Loader2,
  MessagesSquare,
  Mic,
  Paperclip,
  Plus,
  Send,
  Settings,
  Square,
  Target,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 * v1.18.7 (W-coach C-UI): voice dictation returns to the web composer.
 * The earlier placeholder mic was dropped in v1.4.25 because it did
 * nothing on tap; this one is wired to the Web Speech API
 * (`SpeechRecognition`). While the user dictates, interim + final
 * transcripts append into the controlled `value`; the button toggles
 * listening on/off and is fully keyboard- and screen-reader-accessible.
 *
 * v1.25.0: the mic only renders when dictation is genuinely usable —
 * the Web Speech API exists AND the page runs in a secure context (the
 * recogniser refuses to start over plain HTTP). On SSR, an unsupported
 * browser (Firefox), a non-secure self-host, or after the user denies the
 * mic permission, the control HIDES rather than sitting as an
 * advertised-but-erroring affordance. A real failure mid-use surfaces a
 * single quiet toast and then retires the button for the session.
 *
 * v1.18.11 (W11): the composer is the conversation's control hub on the
 * full-page Coach surface — ChatGPT-style. When `showHub` is set it grows a
 * second action row INSIDE the rounded field: a leading `+` actions menu
 * (new chat + open conversations), a settings deep-link, the dictation mic,
 * and the send / stop control on the same baseline. The drawer surface omits
 * `showHub` and keeps the single-row composer (its own header carries new
 * chat + settings), so this is purely additive — the existing composer
 * behaviour and markup are untouched when the hub is off.
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
  /**
   * v1.16.5 — placeholder override. The guided clarifying-questions
   * flow swaps the generic "ask anything" prompt for an answer cue
   * while a question is live. Falls back to the stock composer copy.
   */
  placeholder?: string;
  /**
   * v1.18.11 — mount the control-hub action row (leading `+` menu +
   * settings link) inside the composer card. The page surface sets this;
   * the drawer leaves it off and keeps the single-row composer.
   */
  showHub?: boolean;
  /**
   * v1.18.11 — start a fresh conversation. Wired into the `+` actions
   * menu. Required when `showHub` is set.
   */
  onNewChat?: () => void;
  /**
   * v1.18.11 — open the left conversation-history drawer. Wired into the
   * `+` actions menu. Required when `showHub` is set.
   */
  onOpenHistory?: () => void;
  /**
   * v1.29.x (S7) — mount the document-attach trigger (a leading paperclip menu:
   * "Choose from documents" + "Upload new document"). Set by the parent only
   * when the `inboundDocuments` module is enabled for the user; hidden entirely
   * otherwise. Separate from the `showHub` `+` actions menu — this affordance
   * stages fenced document attachments, it does not manage conversations.
   */
  attachEnabled?: boolean;
  /**
   * v1.29.x (S7) — open the vault picker dialog. The parent owns the dialog +
   * the staged-attachment state. Required when `attachEnabled` is set.
   */
  onPickFromVault?: () => void;
  /**
   * v1.29.x (S7) — the user chose files from the "Upload new document" item.
   * The parent uploads them through the existing `/api/documents/inbound`
   * pipeline and stages the resulting documents as indexing pills.
   */
  onUploadNew?: (files: File[]) => void;
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

/**
 * v1.18.7 — resolve the browser's `SpeechRecognition` constructor
 * (prefixed `webkit` on Chromium / Safari, unprefixed on the spec
 * track). Returns `null` server-side and on browsers without the API
 * (Firefox) so the mic control hides rather than rendering dead. Kept
 * tiny + typed locally — the project ships no DOM lib entry for the
 * Web Speech API.
 */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionErrorEventLike = { error?: string };
type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// v1.18.7 — `useSyncExternalStore` resolves Web Speech API support
// without a setState-in-effect: the server snapshot is `false` (no
// mic at SSR) and the client snapshot reflects whether the constructor
// exists. The store never changes after hydration, so the subscribe
// callback is a no-op.
//
// v1.25.0 — the snapshot also requires a SECURE CONTEXT. `SpeechRecognition`
// throws / fires a `not-allowed` error the instant it starts over plain HTTP,
// so a LAN / Tailscale self-host on `http://` would otherwise advertise a mic
// that can never work. Gating support on `window.isSecureContext` hides it
// there cleanly instead.
const noopSubscribe = () => () => {};
function useVoiceSupported(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => getSpeechRecognitionCtor() !== null && window.isSecureContext,
    () => false,
  );
}

// v1.25.0 — map the app locale onto a BCP-47 tag with a region the
// recogniser accepts. The bare language subtag works in most engines, but
// the regioned form ("de-DE", "es-ES", …) yields materially better accuracy
// on Chromium / Safari. Unknown locales fall back to the bare subtag.
const SPEECH_RECOGNITION_LANG: Record<string, string> = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  pl: "pl-PL",
};

export function CoachInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
  isStreaming = false,
  inputId = "coach-composer-textarea",
  autoFocusOnOpen = false,
  placeholder,
  showHub = false,
  onNewChat,
  onOpenHistory,
  attachEnabled = false,
  onPickFromVault,
  onUploadNew,
}: CoachInputProps) {
  const { t, locale } = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement | null>(null);

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

  // v1.18.7 — voice dictation. The mic control only mounts once the
  // client confirms the Web Speech API exists (resolved through
  // `useSyncExternalStore`, server snapshot `false`), so SSR +
  // unsupported browsers render no button at all — never a dead
  // affordance. `onChange` / `value` are mirrored into refs (in an
  // effect, never during render) so the long-lived recognition handlers
  // always read the freshest composer state without re-subscribing.
  const voiceSupported = useVoiceSupported();
  const [listening, setListening] = useState(false);
  // v1.25.0 — once the user denies the mic permission (or the engine reports
  // it cannot serve), retire the control for the session rather than leaving a
  // button that errors on every tap. Combined with `voiceSupported` this is
  // the single gate the mic renders behind.
  const [voiceBlocked, setVoiceBlocked] = useState(false);
  const voiceAvailable = voiceSupported && !voiceBlocked;
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  });

  // Tear the recogniser down on unmount so a live mic never outlives
  // the composer (e.g. the drawer closing mid-dictation).
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const startDictation = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = SPEECH_RECOGNITION_LANG[locale] ?? locale;
    recognition.continuous = true;
    recognition.interimResults = true;
    // Anchor every transcript onto the text present when dictation
    // began so interim results replace cleanly rather than stacking.
    const base = valueRef.current;
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      const spoken = (finalText + interimText).trim();
      if (!spoken) return;
      const joiner = base && !base.endsWith(" ") ? " " : "";
      onChangeRef.current(`${base}${joiner}${spoken}`);
    };
    recognition.onerror = (event) => {
      setListening(false);
      // `aborted` / `no-speech` are the benign codes that fire on a normal
      // stop or a quiet pause — stay silent.
      const code = event?.error;
      if (!code || code === "aborted" || code === "no-speech") return;
      // v1.25.0 — a permission refusal (or an engine that reports it cannot
      // serve) is terminal: surface one quiet toast and HIDE the mic for the
      // session so the user is not left tapping a control that always errors.
      if (code === "not-allowed" || code === "service-not-allowed") {
        setVoiceBlocked(true);
      }
      toast.error(t("insights.coach.dictateError"));
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if already running; treat as a no-op.
      setListening(false);
    }
  }, [locale, t]);

  const toggleDictation = useCallback(() => {
    if (!voiceAvailable) return;
    if (listening) stopDictation();
    else startDictation();
  }, [voiceAvailable, listening, startDictation, stopDictation]);

  // The mic only renders when dictation is available, so the label tracks the
  // two live states: listening (tap to stop) and idle (tap to dictate).
  const micLabel = listening
    ? t("insights.coach.dictateStop")
    : t("insights.coach.dictate");

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

  // v1.18.11 — the dictation mic. Lifted to a const so it can sit in the
  // single-row composer (drawer) OR in the hub action row (page) without
  // duplicating the wiring. v1.25.0 — `null` when dictation is unavailable
  // (no API, non-secure context, or a denied permission) so the surface hides
  // the control rather than advertising a button that errors on tap.
  const micButton = voiceAvailable ? (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={toggleDictation}
      disabled={disabled}
      data-slot="coach-input-mic"
      data-listening={listening ? "true" : undefined}
      aria-label={micLabel}
      aria-pressed={listening}
      title={micLabel}
      className={cn(
        "size-11 shrink-0 rounded-xl transition-colors sm:size-9",
        listening
          ? "text-brand-pink bg-brand-pink/10 hover:text-brand-pink"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Mic
        className={cn(
          "size-4",
          listening && "animate-pulse motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
    </Button>
  ) : null;

  // v1.18.11 — the send / stop control. Same const-lift rationale as the
  // mic: one definition, two mount points.
  const sendButton =
    isStreaming && onCancel ? (
      // While a reply streams, swap the send button for a Stop control bound
      // to the abort handler so the user can interrupt a long or off-track
      // reply instead of waiting it out.
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onCancel}
        data-slot="coach-input-stop"
        aria-label={t("insights.coach.stop")}
        title={t("insights.coach.stop")}
        className="size-11 shrink-0 rounded-xl sm:size-9"
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
        className="size-11 shrink-0 rounded-xl sm:size-9"
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
    );

  // v1.21.0 — the leading `+` actions menu (page surface only). Opens the
  // attachment/scope menu: new chat + open conversations. The settings gear
  // no longer lives here — it moved to the page toolbar's top-right corner,
  // so the composer's front is ONLY the `+`. Const-lifted like the mic / send
  // so it slots into the single-row composer without forking the layout.
  const actionsButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          data-slot="coach-input-actions"
          aria-label={t("insights.coach.actionsMenu")}
          title={t("insights.coach.actionsMenu")}
          className="text-muted-foreground hover:text-foreground size-11 shrink-0 rounded-xl sm:size-9"
        >
          <Plus className="size-5 sm:size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-52">
        <DropdownMenuItem
          data-slot="coach-input-action-new-chat"
          onSelect={() => onNewChat?.()}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("insights.coach.newChat")}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-slot="coach-input-action-history"
          onSelect={() => onOpenHistory?.()}
        >
          <MessagesSquare className="size-4" aria-hidden="true" />
          {t("insights.coach.historyTitle")}
        </DropdownMenuItem>
        <DropdownMenuItem asChild data-slot="coach-input-action-plans">
          <Link href="/coach/plans">
            <Target className="size-4" aria-hidden="true" />
            {t("coach.plans.title")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild data-slot="coach-input-action-settings">
          <Link href="/settings/ai">
            <Settings className="size-4" aria-hidden="true" />
            {t("insights.coach.settings")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // v1.29.x (S7) — the document-attach affordance: a leading paperclip menu
  // ("Choose from documents" opens the vault picker; "Upload new document"
  // opens the file input, reusing the existing `/api/documents/inbound`
  // pipeline). Rendered only when the parent enables it (module-gated). It is a
  // SEPARATE control from the `showHub` `+` actions menu — the two never merge.
  const attachButton = attachEnabled ? (
    <>
      <input
        ref={attachFileInputRef}
        type="file"
        multiple
        className="hidden"
        data-slot="coach-input-attach-file"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so re-selecting the same file re-fires `change`.
          event.target.value = "";
          if (files.length > 0) onUploadNew?.(files);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            data-slot="coach-input-attach"
            aria-label={t("insights.coach.attach.trigger")}
            title={t("insights.coach.attach.trigger")}
            className="text-muted-foreground hover:text-foreground size-11 shrink-0 rounded-xl sm:size-9"
          >
            <Paperclip className="size-5 sm:size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        {/* v1.29.1 — the item labels shrink + truncate within the popover width
            (`min-w-0` + a `truncate` span) so a long localised label — e.g.
            "Neues Dokument hochladen" — can never overflow past the menu edge.
            Mirrors the vault picker items' width handling. */}
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuItem
            data-slot="coach-input-attach-vault"
            onSelect={() => onPickFromVault?.()}
          >
            <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {t("insights.coach.attach.menuChooseFromDocuments")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-slot="coach-input-attach-upload"
            // Defer the input click a tick so the Radix menu finishes closing
            // and returning focus before the native file dialog opens.
            onSelect={() =>
              setTimeout(() => attachFileInputRef.current?.click(), 0)
            }
          >
            <Upload className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {t("insights.coach.attach.menuUploadNew")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  ) : null;

  return (
    <form
      data-slot="coach-input"
      onSubmit={handleFormSubmit}
      className="flex flex-col"
    >
      {/* v1.16.1 / v1.18.7 — modern chat-app composer: a single rounded
          field, ONE baseline row. The drawer surface flanks the textarea with
          the mic (left) and send / stop (right). The page surface (`showHub`)
          leads with a `+` actions menu (new chat + open conversations), then
          the textarea, then the mic + send — same row, vertically centred.
          The settings gear is NOT in the composer; it lives in the page
          toolbar's top-right corner. `items-end` keeps the flanking controls
          pinned to the input's last line as it grows. Enter sends,
          Shift+Enter inserts a newline. */}
      <div
        className={cn(
          "border-border/60 bg-muted/40 group rounded-2xl border",
          "shadow-sm transition-colors",
          "focus-within:border-primary/50 focus-within:ring-primary/50 focus-within:bg-background focus-within:ring-2",
          // Both surfaces share ONE baseline row: the drawer flanks the
          // textarea with mic (left) + send (right); the page leads with a
          // `+` actions menu, then the textarea, then mic + send. `items-end`
          // keeps the flanking controls pinned to the input's last line as it
          // grows.
          "flex items-end gap-1.5 p-1.5",
        )}
      >
        {/* Leading controls. The document-attach paperclip (module-gated)
            leads, then the surface control: the `+` actions menu (page) or the
            dictation mic (drawer). */}
        {attachButton}
        {showHub ? actionsButton : micButton}
        <textarea
          id={inputId}
          ref={textareaRef}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t("insights.coach.composerPlaceholder")}
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
            // Centre the single-line state against the flanking controls so
            // the placeholder and the icons share a baseline.
            "px-2 py-1.5",
            "max-h-[9.5rem] overflow-auto",
            // v1.18.7 — calm, thin scrollbar inside the composer when
            // dictation overruns 6 lines (see also the thread/history
            // scroll regions). Scoped here, not in globals.css.
            "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--primary)_35%,transparent)_transparent]",
            "placeholder:text-muted-foreground disabled:opacity-60",
            // Keep the placeholder a single line on narrow phones: a long
            // hint used to wrap to two lines inside the one-row composer and
            // read as a cramped block. Clip the PLACEHOLDER pseudo only — the
            // textarea value still wraps and auto-grows for real typing.
            "placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap",
          )}
        />
        {showHub ? (
          // v1.21.0 — page surface trailing cluster: mic + send / stop on the
          // same baseline as the leading `+` and the textarea. The settings
          // gear moved out of the composer entirely (now in the page toolbar).
          <div
            data-slot="coach-input-hub"
            className="flex shrink-0 items-center gap-1.5"
          >
            {micButton}
            {sendButton}
          </div>
        ) : (
          sendButton
        )}
      </div>
    </form>
  );
}
