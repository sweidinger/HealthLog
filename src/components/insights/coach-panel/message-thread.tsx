"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BookmarkPlus,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
  Volume2,
  VolumeX,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { ABOUT_ME_FIELD_MAX_CHARS } from "@/lib/validations/about-me";
import {
  parseChartTokens,
  stripChartTokens,
  tokenToMetric,
  type ChartToken,
} from "@/lib/insights/chart-tokens";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { ProseBlocks } from "@/components/insights/prose-blocks";

import { SourceChips } from "./source-chips";
import { ReminderSuggestionCard } from "./reminder-suggestion-card";
import { SuggestedActionCard } from "./suggested-action-card";
import { StreamedProse } from "./streamed-prose";
import { MessageTokenFooter } from "./message-token-footer";
import type {
  CoachConversationDetailDTO,
  CoachOptimisticUserMessage,
  CoachStreamingMessage,
} from "./use-coach";
import type {
  CoachMessageDTO,
  CoachProvenanceMetric,
} from "@/lib/ai/coach/types";

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
  /**
   * v1.4.25 W5 — optimistic user message surfaced by the send hook so
   * the user sees their own bubble before the "Thinking…" placeholder.
   * Cleared by the hook once the SSE `done` frame fires (the persisted
   * twin lands via the invalidate-refetch). When the persisted twin is
   * already in `conversation.messages` we suppress the optimistic copy
   * so the user never sees the same bubble twice.
   */
  optimisticUser?: CoachOptimisticUserMessage | null;
  /** Empty-state copy when no conversation is loaded yet. */
  emptyHint?: string;
  /**
   * v1.16.5 — locally-rendered bubbles the guided clarifying-questions
   * flow interleaves with the persisted history (deterministic Coach
   * questions + the closing summary). Items anchored on an answer
   * render immediately before the user message that answered them;
   * unanchored items render at the thread tail. See `placeInterleaved`.
   */
  interleaved?: InterleavedThreadItem[];
  /**
   * v1.22 — "Try again" on an assistant turn. The thread resolves the user
   * message that produced the reply and hands its text up; the surface
   * resubmits it as a fresh turn. Omitted → the regenerate action is hidden.
   */
  onRegenerate?: (userText: string) => void;
}

/**
 * v1.16.5 — one locally-rendered thread bubble contributed by the
 * guided clarifying-questions flow. The thread owns only the placement;
 * the node's behaviour lives with the flow in `coach-conversation`.
 */
export interface InterleavedThreadItem {
  key: string;
  /**
   * Content of the user message this item precedes (a guided question
   * renders above its answer). `null` → render at the thread tail
   * (the current question / the summary).
   */
  anchorAnswer: string | null;
  node: React.ReactNode;
}

/**
 * Pure placement for interleaved items, exported for unit tests.
 * Items are chronological by construction (the guided flow emits them
 * in question order), so a single forward pointer suffices: each
 * anchored item consumes the first remaining user message whose
 * content equals its anchor. Anchors that never match (e.g. an errored
 * turn whose message was never persisted) fall through to the tail so
 * no bubble is ever silently dropped.
 */
export function placeInterleaved(
  items: InterleavedThreadItem[],
  messages: { id: string; role: string; content: string }[],
  optimisticContent: string | null,
): {
  before: Map<string, InterleavedThreadItem>;
  beforeOptimistic: InterleavedThreadItem[];
  tail: InterleavedThreadItem[];
} {
  const anchored = items.filter((i) => i.anchorAnswer !== null);
  const before = new Map<string, InterleavedThreadItem>();
  let p = 0;
  for (const m of messages) {
    if (p >= anchored.length) break;
    if (m.role === "user" && m.content === anchored[p].anchorAnswer) {
      before.set(m.id, anchored[p]);
      p += 1;
    }
  }
  const beforeOptimistic: InterleavedThreadItem[] = [];
  if (
    p < anchored.length &&
    optimisticContent !== null &&
    optimisticContent === anchored[p].anchorAnswer
  ) {
    beforeOptimistic.push(anchored[p]);
    p += 1;
  }
  const tail = [
    ...anchored.slice(p),
    ...items.filter((i) => i.anchorAnswer === null),
  ];
  return { before, beforeOptimistic, tail };
}

/**
 * v1.18.7 — shared thin/rounded/subtle scrollbar styling for the Coach
 * scroll regions (the message thread + the history list). Kept as a
 * Tailwind-arbitrary class string so the styling is component-scoped —
 * the parallel agent owns `globals.css` and we must not touch it.
 *
 * Firefox: `scrollbar-width: thin` + a tinted thumb on a transparent
 * track. WebKit: an 8 px overlay-style thumb with a fully rounded
 * radius and no arrow buttons, brightening on hover. The Dracula purple
 * is mixed down so the bar reads as a hairline accent, not a hard edge.
 */
export const COACH_SCROLLBAR = cn(
  "[scrollbar-color:color-mix(in_srgb,var(--dracula-purple)_30%,transparent)_transparent] [scrollbar-width:thin]",
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2",
  "[&::-webkit-scrollbar-track]:bg-transparent",
  "[&::-webkit-scrollbar-button]:hidden [&::-webkit-scrollbar-button]:size-0",
  "[&::-webkit-scrollbar-thumb]:rounded-full",
  "[&::-webkit-scrollbar-thumb]:border-[3px] [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content",
  "[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--dracula-purple)_30%,transparent)]",
  "hover:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--dracula-purple)_45%,transparent)]",
);

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * v1.4.25 W5 — map server-emitted error codes to specific Coach i18n
 * keys. The chat route distinguishes the daily user-quota
 * (`coach.budget.exceeded`, returned as a JSON 429) from the provider
 * rate-limit (`coach.provider.rate_limited`, streamed as an SSE error
 * frame). Both used to surface as the generic provider-unavailable
 * copy; we now route each to its dedicated translation so the user
 * understands whether the limit is on their side (reset at UTC
 * midnight) or transient on the provider side (retry in ~5 min).
 *
 * Exported so the resolver can be pinned by unit tests without
 * standing up the whole thread renderer.
 */
export function errorCodeToI18nKey(code: string): string {
  switch (code) {
    case "coach.budget.exceeded":
      return "insights.coach.dailyLimitBody";
    case "coach.provider.rate_limited":
      return "insights.coach.providerRateLimitBody";
    case "coach.network":
      // v1.4.43 QoL (M6) — a dropped network is the user's local
      // problem and needs a different next action ("come back online")
      // than a provider failure ("try again in a moment"). Split out
      // so the user sees the actionable copy in the offline branch.
      return "insights.coach.errorNetwork";
    case "coach.provider.credential_expired":
      // v1.11.0 W1 — the user's primary AI provider credential is dead
      // (auth-class failure). The next action is "reconnect", not "try
      // again later", so it carries its own copy pointing at Settings.
      return "insights.coach.errorCredentialExpired";
    case "coach.provider.none":
      // v1.18.6 — no AI provider is configured anywhere, so "try again
      // in a moment" is the wrong instruction (it will 422 forever). Send
      // the user to guided setup with a one-line explainer + a Settings
      // link rendered alongside the bubble copy.
      return "insights.coach.errorNoProvider";
    case "coach.provider.unavailable":
    case "coach.provider.empty":
    case "coach.stream":
      return "insights.coach.errorProvider";
    default:
      // Forward-compat: try `insights.coach.<code>` for codes that
      // ship their own translation (e.g. legacy `errorProvider`).
      return `insights.coach.${code}`;
  }
}

/**
 * v1.22 (W5) — Coach accompanying charts, Phase 1: the renderer half.
 *
 * The chart-token mechanism (`chart-tokens.ts`) was prepared for the
 * Insights prose but its render path was never wired for the Coach —
 * `stripChartTokens` cleaned tokens out of the prose, but `parseChartTokens`
 * had no caller, so a `metric:<TYPE>` token the model emitted rendered no
 * chart. This map activates the render half for the Coach.
 *
 * Each entry pairs an allowlisted chart token with the Coach provenance
 * TOPIC that the snapshot stamps when it actually drew on that metric. A
 * chart only renders when its topic is present in `metricSource.metrics`, so
 * the series is grounded twice over: the closed allowlist drops a
 * hallucinated token, and the provenance intersect drops a metric the turn
 * never saw (and which therefore has no data). The chart itself self-fetches
 * the user's real series from `/api/measurements` — the model never emits a
 * data point.
 *
 * Only MeasurementType-backed tokens that render through the generic,
 * self-fetching `<HealthChart>` are listed. The synthetic `metric:MOOD`
 * token (served by a separate `<MoodChart>`) and the allowlist's reserved
 * score classes are intentionally omitted from Phase 1.
 *
 * The prompt clause that tells the model it MAY emit one such token is a
 * separate concern (the narrative/prompt workstream); this is render-only,
 * provider-agnostic (it reads the plain inline token, so it works for every
 * provider including the codex inline-text path), and a graceful no-op when
 * no grounded token is present.
 */
const CHART_TOKEN_PROVENANCE: Partial<
  Record<ChartToken, CoachProvenanceMetric>
> = {
  "metric:WEIGHT": "weight",
  "metric:BLOOD_PRESSURE_SYS": "bp",
  "metric:BLOOD_PRESSURE_DIA": "bp",
  "metric:PULSE": "pulse",
  "metric:BODY_FAT": "body_fat",
  "metric:SLEEP_DURATION": "sleep",
  "metric:ACTIVITY_STEPS": "steps",
  "metric:BLOOD_GLUCOSE": "glucose",
  "metric:TOTAL_BODY_WATER": "total_body_water",
  "metric:BONE_MASS": "bone_mass",
  "metric:OXYGEN_SATURATION": "spo2",
  "metric:HEART_RATE_VARIABILITY": "hrv",
  "metric:RESTING_HEART_RATE": "resting_hr",
  "metric:ACTIVE_ENERGY_BURNED": "active_energy",
  "metric:FLIGHTS_CLIMBED": "flights",
  "metric:WALKING_RUNNING_DISTANCE": "distance",
  "metric:VO2_MAX": "vo2_max",
  "metric:BODY_TEMPERATURE": "body_temp",
  "metric:FAT_FREE_MASS": "fat_free_mass",
  "metric:FAT_MASS": "fat_mass",
  "metric:MUSCLE_MASS": "muscle_mass",
  "metric:LEAN_BODY_MASS": "lean_body_mass",
  "metric:BODY_MASS_INDEX": "bmi",
  "metric:VISCERAL_FAT": "visceral_fat",
  "metric:SKIN_TEMPERATURE": "skin_temp",
  "metric:RESPIRATORY_RATE": "respiratory_rate",
  "metric:PULSE_WAVE_VELOCITY": "pulse_wave_velocity",
  "metric:VASCULAR_AGE": "vascular_age",
  "metric:WALKING_HEART_RATE_AVERAGE": "walking_hr",
  "metric:WALKING_ASYMMETRY": "walking_asymmetry",
  "metric:WALKING_DOUBLE_SUPPORT": "walking_double_support",
  "metric:WALKING_STEP_LENGTH": "walking_step_length",
  "metric:WALKING_SPEED": "walking_speed",
  "metric:AUDIO_EXPOSURE_ENV": "audio_env",
  "metric:AUDIO_EXPOSURE_HEADPHONE": "audio_headphone",
  "metric:AUDIO_EXPOSURE_EVENT": "audio_event",
  "metric:TIME_IN_DAYLIGHT": "daylight",
};

/** Max charts rendered under a single Coach turn (keeps the reply scannable). */
const MAX_COACH_CHARTS = 2;

/**
 * Pure selection of the chart tokens to render under an assistant turn:
 * allowlist-parsed, intersected with the turn's grounded provenance topics,
 * de-duplicated by metric, and capped. Exported for unit tests so the
 * grounding contract is pinned without standing up the chart component.
 */
export function selectCoachChartTokens(
  content: string,
  metrics: readonly CoachProvenanceMetric[] | undefined,
): ChartToken[] {
  const grounded = new Set(metrics ?? []);
  const out: ChartToken[] = [];
  const seen = new Set<string>();
  for (const token of parseChartTokens(content)) {
    const topic = CHART_TOKEN_PROVENANCE[token];
    if (!topic || !grounded.has(topic)) continue;
    const metric = tokenToMetric(token);
    if (seen.has(metric)) continue;
    seen.add(metric);
    out.push(token);
    if (out.length >= MAX_COACH_CHARTS) break;
  }
  return out;
}

/**
 * Chart tokens whose canonical measurement-type label has no dedicated
 * `measurements.type*` key — route them to the closest existing key so the
 * chart header reads cleanly rather than echoing the raw enum.
 */
const CHART_TITLE_KEY_OVERRIDE: Record<string, string> = {
  BLOOD_PRESSURE_SYS: "measurements.typeBloodPressure",
  BLOOD_PRESSURE_DIA: "measurements.typeBloodPressure",
};

/** Localised chart header for a MeasurementType, mirroring the snapshot's
 *  `measurements.type<Camel>` convention with a readable fallback. */
function coachChartTitle(
  metric: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const override = CHART_TITLE_KEY_OVERRIDE[metric];
  if (override) {
    const resolved = t(override);
    if (resolved !== override) return resolved;
  }
  const camel = metric
    .toLowerCase()
    .split("_")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const key = `measurements.type${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  const resolved = t(key);
  return resolved === key ? metric.replace(/_/g, " ").toLowerCase() : resolved;
}

/**
 * v1.22 (W5) — feature-detect the browser Speech Synthesis API SSR-safe.
 * `useSyncExternalStore` returns false on the server + first client paint
 * (so the read-aloud button is absent in markup) and resolves to the real
 * capability after hydration, mirroring the mic button's detection pattern
 * — no hydration mismatch warning, no `connect-src` (it runs in-browser).
 */
function useSpeechSynthesisSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () =>
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      "SpeechSynthesisUtterance" in window,
    () => false,
  );
}

/**
 * v1.22.1 — feature-detect the async Clipboard API SSR-safe, mirroring the
 * Speech-Synthesis detection above. `navigator.clipboard` is `undefined` on
 * plain-HTTP self-hosts (a supported insecure-context config), so the copy
 * button must be absent there rather than rendering and error-toasting on tap.
 * `useSyncExternalStore` returns false on the server + first client paint and
 * resolves to the real capability after hydration — no hydration mismatch.
 */
function useClipboardSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function",
    () => false,
  );
}

/**
 * v1.22 — score a synthesis voice for a target language. Higher is better;
 * a negative score marks a legacy/compact voice we would rather skip. Pure
 * (no browser globals) so the ranking contract is unit-testable. Exported
 * for the read-aloud voice-selection test.
 *
 * The default OS voice is often a legacy "compact" engine (Anna, Albert,
 * Zarvox, eSpeak) that reads robotically. We prefer, in order: an Apple
 * enhanced/premium or Siri voice, a Microsoft "Natural"/"Online" (Edge)
 * voice, a "Google …" (Chrome) voice, and a small set of known-good names
 * (Samantha). An exact lang-REGION match (de-DE/en-US) outweighs a bare
 * language match. `localService` only breaks a tie. Known-bad names are
 * penalised so they never win over a neutral remote voice.
 */
export function scoreSpeechVoice(
  voice: { name: string; lang: string; localService?: boolean },
  lang: string,
): number {
  const base = lang.split("-")[0].toLowerCase();
  const vlang = voice.lang.toLowerCase().replace("_", "-");
  if (!vlang.startsWith(base)) return -Infinity;
  const name = voice.name.toLowerCase();
  let score = 0;

  // Exact lang-REGION match (de-DE, en-US) over a bare language match.
  if (lang.includes("-") && vlang === lang.toLowerCase()) score += 40;

  // High-quality engines.
  if (/\b(enhanced|premium)\b/.test(name)) score += 60;
  if (name.includes("siri")) score += 55;
  if (name.includes("natural") || name.includes("online")) score += 50;
  if (name.startsWith("google")) score += 35;
  if (name.includes("samantha")) score += 30;

  // Known-bad legacy / compact engines.
  if (name.includes("compact")) score -= 80;
  if (/\b(albert|zarvox|espeak|anna|fred|ralph|bahh|trinoids)\b/.test(name)) {
    score -= 100;
  }

  // Tie-breaker only: a local voice has no network latency.
  if (voice.localService) score += 1;

  return score;
}

/**
 * v1.22 — pick the best-scoring installed voice for `lang`, or null when
 * none beats a legacy/compact default (graceful fallback to the browser
 * default). Pure helper, exported for the ranking test.
 */
export function pickSpeechVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
): SpeechSynthesisVoice | null {
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0; // require a positive score to override the default
  for (const v of voices) {
    const s = scoreSpeechVoice(v, lang);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

/**
 * v1.22 (W5) — read the assistant prose aloud via the browser's
 * `SpeechSynthesis`. Client-only, no dependency, no egress, CSP-clean. A
 * single in-flight utterance: a new `speak` cancels any prior one; `toggle`
 * stops while speaking.
 *
 * v1.22 — natural-voice selection. The browser default is frequently a
 * legacy/compact engine that reads robotically; instead of only stamping
 * `utterance.lang` we enumerate `getVoices()`, rank the candidates for the
 * locale (`pickSpeechVoice`), and assign the winner. The voice list is async
 * (empty on the first call, and on iOS Safari it can stay empty until the
 * first user-gesture speak), so we subscribe to `voiceschanged` and also
 * re-read it lazily on the first toggle. The chosen voice is cached per
 * locale in a ref so the ranking runs once.
 */
function useReadAloud(): {
  supported: boolean;
  speaking: boolean;
  toggle: (text: string, lang: string) => void;
} {
  const supported = useSpeechSynthesisSupported();
  const [speaking, setSpeaking] = useState(false);
  // Cache the resolved voice per locale so the ranking runs once.
  const voiceByLocaleRef = useRef<Map<string, SpeechSynthesisVoice | null>>(
    new Map(),
  );

  // Pre-warm the voice list + keep it fresh: the list arrives asynchronously
  // and `voiceschanged` fires when the OS finishes loading installed voices.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      // A late-arriving list can surface a better voice than an early read;
      // clear the cache so the next toggle re-ranks against the full set.
      voiceByLocaleRef.current.clear();
    };
    synth.getVoices();
    synth.addEventListener?.("voiceschanged", refresh);
    return () => synth.removeEventListener?.("voiceschanged", refresh);
  }, [supported]);

  // Stop any in-flight utterance if the bubble unmounts (thread reset, nav).
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const resolveVoice = useCallback(
    (synth: SpeechSynthesis, lang: string): SpeechSynthesisVoice | null => {
      const cached = voiceByLocaleRef.current.get(lang);
      if (cached !== undefined) return cached;
      const voices = synth.getVoices();
      // An empty list (first call / iOS pre-gesture) is not cached so a later
      // toggle re-ranks once the OS has populated the voices.
      if (voices.length === 0) return null;
      const chosen = pickSpeechVoice(voices, lang);
      voiceByLocaleRef.current.set(lang, chosen);
      return chosen;
    },
    [],
  );

  const toggle = useCallback(
    (text: string, lang: string) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      if (speaking) {
        synth.cancel();
        setSpeaking(false);
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      const voice = resolveVoice(synth, lang);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = lang;
      }
      // A natural cadence: default rate, neutral pitch.
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      synth.speak(utterance);
    },
    [supported, speaking, resolveVoice],
  );

  return { supported, speaking, toggle };
}

/**
 * v1.22 — shared styling for the icon-only per-message action buttons. One
 * tap convention across Copy / Read-aloud / feedback / Try-again: a 44px
 * mobile tap floor (WCAG 2.5.5) collapsing to a compact 32px desktop target,
 * muted until hover/focus, with the standard focus ring.
 */
const COACH_ICON_BUTTON = cn(
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
  "inline-flex size-11 min-w-11 shrink-0 items-center justify-center rounded",
  "outline-none focus-visible:ring-2 disabled:opacity-50 sm:size-8 sm:min-w-8",
);

/**
 * v1.22 (W5) — read-aloud toggle for a settled assistant turn. Hidden when
 * the browser has no Speech Synthesis support. Speaks `stripChartTokens`
 * (the same text the prose shows), so stray tokens are never voiced.
 */
function ReadAloudButton({ content }: { content: string }) {
  const { t, locale } = useTranslations();
  const { supported, speaking, toggle } = useReadAloud();
  if (!supported) return null;
  const label = speaking
    ? t("insights.coach.readAloudStop")
    : t("insights.coach.readAloud");
  return (
    <button
      type="button"
      data-slot="coach-read-aloud"
      onClick={() => toggle(stripChartTokens(content), locale)}
      aria-label={label}
      aria-pressed={speaking}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      {speaking ? (
        <VolumeX className="size-3.5" aria-hidden="true" />
      ) : (
        <Volume2 className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * v1.22 — copy a message to the clipboard. Assistant prose is copied through
 * `stripChartTokens` (the same text the bubble shows) so inline chart tokens
 * are never pasted; user text is verbatim. A brief check-mark + toast confirm
 * the copy. Hidden when the Clipboard API is unavailable (insecure context).
 */
function CopyMessageButton({
  content,
  strip,
}: {
  content: string;
  strip: boolean;
}) {
  const { t } = useTranslations();
  const supported = useClipboardSupported();
  const [copied, setCopied] = useState(false);
  const handle = useCallback(async () => {
    const text = strip ? stripChartTokens(content) : content;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("insights.coach.copyMessageError"));
    }
  }, [content, strip, t]);
  // Absent on insecure-context (plain-HTTP) self-hosts where the Clipboard API
  // is undefined — render nothing rather than error-toast on tap.
  if (!supported) return null;
  const label = t("insights.coach.copyMessage");
  return (
    <button
      type="button"
      data-slot="coach-copy-message"
      onClick={handle}
      aria-label={label}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      {copied ? (
        <Check className="text-dracula-green size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * v1.22 — "Try again": re-run the user turn that produced this assistant
 * reply so the user can regenerate an unsatisfying answer. The thread hands
 * down the preceding user message; the surface resubmits it as a fresh turn.
 */
function TryAgainButton({ onRegenerate }: { onRegenerate: () => void }) {
  const { t } = useTranslations();
  const label = t("insights.coach.regenerate");
  return (
    <button
      type="button"
      data-slot="coach-try-again"
      onClick={onRegenerate}
      aria-label={label}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * v1.22 (W5) — hover/tap timestamp for a persisted message bubble. A small,
 * calm clock affordance; the locale-aware date + time surfaces in a tooltip
 * on hover or keyboard focus (desktop) and on tap (mobile, toggled state).
 * Pure CSS + one boolean — no portal, no Radix dependency, SSR-safe.
 */
function BubbleTimestamp({
  iso,
  align = "start",
}: {
  iso: string;
  align?: "start" | "end";
}) {
  const { t } = useTranslations();
  const formatters = useFormatters();
  const [open, setOpen] = useState(false);
  const label = formatters.dateTime(iso);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        data-slot="coach-bubble-timestamp"
        aria-label={t("insights.coach.messageTimeLabel", { time: label })}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className="peer text-muted-foreground/70 hover:text-muted-foreground focus-visible:ring-ring/50 inline-flex size-11 items-center justify-center rounded outline-none focus-visible:ring-2 sm:size-8"
      >
        <Clock className="size-3" aria-hidden="true" />
      </button>
      <span
        role="tooltip"
        className={cn(
          "bg-popover text-popover-foreground border-border pointer-events-none absolute bottom-full z-50 mb-1",
          "rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-md",
          "opacity-0 transition-opacity duration-100 peer-hover:opacity-100 peer-focus-visible:opacity-100",
          "motion-reduce:transition-none",
          open && "opacity-100",
          align === "end" ? "right-0" : "left-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function MessageThread({
  conversation,
  streaming,
  optimisticUser,
  emptyHint,
  interleaved,
  onRegenerate,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);

  // v1.4.27 F14 — the evidence disclosure used to honour an opt-in
  // `coachPrefs.showEvidenceByDefault` flag that surfaced the raw
  // measurement values unconditionally. The flag created an UX trap
  // (the maintainer 2026-05-15: "literal metric values exposed under every
  // bubble") so the disclosure is now collapsed by default for every
  // reply. The user expands by click; the pref is retired in the
  // settings sheet so nothing flips it back on.

  const messages: CoachMessageDTO[] = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  // v1.16.5 — locally-rendered guided bubbles (see `placeInterleaved`).
  const interleavedItems = interleaved ?? [];
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
  // v1.4.22 W5 reconcile (Code-MED-3) — streaming/persisted-twin
  // race. On slow connections SSE `done` fires before the
  // invalidate-refetch resolves; the persisted twin lands while the
  // streaming bubble is still painted, producing a 200-500ms
  // duplicate render. Hide the persisted twin (matched on
  // streaming.messageId) for a 150ms grace window after it first
  // appears so the streaming bubble stays alone until the streaming
  // state cleans up naturally on the next `send`.
  const [graceWindow, setGraceWindow] = useState(false);
  const lastPersistedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const persistedId = streaming?.messageId ?? null;
    if (
      persistedId &&
      persistedId !== lastPersistedIdRef.current &&
      messages.some((m) => m.id === persistedId)
    ) {
      lastPersistedIdRef.current = persistedId;
      setGraceWindow(true);
      const handle = setTimeout(() => setGraceWindow(false), 150);
      return () => clearTimeout(handle);
    }
  }, [streaming?.messageId, messages]);
  const suppressedTwinId = graceWindow ? streaming?.messageId : null;

  const streamingPersisted =
    !graceWindow &&
    streaming?.messageId != null &&
    messages.some((m) => m.id === streaming.messageId);
  const streamingActive =
    !streamingPersisted &&
    (!!streaming?.inProgress || !!streaming?.content || !!streaming?.errorCode);

  // v1.4.25 W5 — render the optimistic user bubble only when the
  // persisted twin hasn't landed yet. We match on (role=user, content
  // equality, no later persisted user message). The server is the
  // source of truth — once the persisted user message lands (via the
  // invalidate-refetch the SSE `done` frame triggers), the optimistic
  // copy is dropped so the user never sees their bubble twice.
  const optimisticActive = (() => {
    if (!optimisticUser) return false;
    // Suppress if the persisted history already contains the same
    // user content as the last user message — the twin has landed.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.content === optimisticUser.content) return false;
    return true;
  })();

  // v1.16.5 — slot the guided bubbles around the persisted history,
  // the optimistic user bubble, and the streaming tail. Cheap on every
  // render: at most a handful of items over a single message walk.
  const placement = placeInterleaved(
    interleavedItems,
    messages,
    optimisticActive && optimisticUser ? optimisticUser.content : null,
  );

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
  // when the user was already at the bottom. v1.4.25 W5 — the
  // optimistic user bubble counts as a new message; scroll on its
  // localId so the user sees their own bubble land at the bottom.
  // v1.16.5 — guided bubbles count as new messages for the auto-scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehaviorForUser() });
    }
  }, [
    messages.length,
    streaming?.content,
    optimisticUser?.localId,
    interleavedItems.length,
  ]);

  // v1.4.27 R3d MB4 / CF-74 — re-pin to the bottom when the
  // visual viewport shrinks (typically the soft keyboard opening on
  // a phone). Without this the last bubble drifts behind the keyboard
  // because the scroller's `scrollHeight` references the layout
  // viewport, not the visible region. Listening on
  // `window.visualViewport.resize` and re-issuing the scroll keeps the
  // tail of the thread visible as the keyboard slides in and out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const el = scrollerRef.current;
      if (!el) return;
      if (wasPinnedRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      }
    };
    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []);

  if (
    messages.length === 0 &&
    !streamingActive &&
    !optimisticActive &&
    interleavedItems.length === 0
  ) {
    return (
      <div
        data-slot="coach-message-thread"
        role="status"
        aria-live="polite"
        className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
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
        // v1.18.6.1 — `min-h-0 flex-1` (not `h-full`) so the scroll region
        // resolves its height from the flex parent rather than a 100%-of-auto
        // chain that let the thread grow instead of scroll.
        // v1.18.7 — calmer vertical rhythm (gap-6) and more generous top/
        // bottom breathing room so the conversation reads like a document,
        // not a chat log packed against the chrome.
        "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6",
        // v1.18.6 (CCH-01) / v1.18.7 — on the wide page surface an edge-to-
        // edge thread sprawled the prose past a readable measure. Centre the
        // content on a narrower, calmer Claude/ChatGPT-like column
        // (`max-w-2xl`) via an `mx-auto` inner gutter; the scrollbar still
        // rides the surface edge. The drawer surface is already narrow, so
        // the cap only bites on the wide page surface.
        "[&>*]:mx-auto [&>*]:w-full [&>*]:max-w-2xl",
        "scroll-smooth",
        // v1.18.7 — thin, rounded, subtle scrollbar (WebKit + Firefox),
        // component-scoped via Tailwind arbitrary variants so globals.css
        // stays untouched. Replaces the default boxy/angular track.
        COACH_SCROLLBAR,
      )}
    >
      {messages.map((m, idx) => {
        // v1.4.22 W5 reconcile (Code-MED-3) — suppress the persisted
        // twin during the 150ms grace window so the streaming bubble
        // stays alone on slow connections.
        if (m.id === suppressedTwinId) return null;
        // v1.16.5 — a guided question renders directly above the user
        // message that answered it.
        const guidedBefore = placement.before.get(m.id);
        // v1.22 — "Try again": resolve the user message that produced this
        // assistant reply (the nearest preceding user turn) so the surface
        // can resubmit it. Null when there is none → no regenerate action.
        let precedingUserContent: string | null = null;
        if (m.role === "assistant" && onRegenerate) {
          for (let j = idx - 1; j >= 0; j--) {
            if (messages[j].role === "user") {
              precedingUserContent = messages[j].content;
              break;
            }
          }
        }
        return (
          <Fragment key={m.id}>
            {guidedBefore?.node}
            <ChatBubble
              role={m.role}
              content={m.content}
              metricSource={m.metricSource}
              providerType={m.providerType}
              messageId={m.id}
              tokensUsed={m.tokensUsed}
              model={m.model}
              createdAt={m.createdAt}
              onRegenerate={
                precedingUserContent !== null && onRegenerate
                  ? () => onRegenerate(precedingUserContent as string)
                  : undefined
              }
            />
          </Fragment>
        );
      })}
      {/* v1.4.25 W5 — optimistic user bubble surfaces between the
          persisted history and the streaming assistant placeholder so
          the visible order matches the user's mental model. The
          send-hook drops it as soon as the SSE `done` frame fires +
          the invalidate-refetch lands the persisted twin. */}
      {/* v1.16.5 — guided question whose answer is still optimistic-only. */}
      {placement.beforeOptimistic.map((i) => (
        <Fragment key={i.key}>{i.node}</Fragment>
      ))}
      {optimisticActive && optimisticUser && (
        <ChatBubble
          key={optimisticUser.localId}
          role="user"
          content={optimisticUser.content}
        />
      )}
      {streamingActive && streaming && (
        // role=log + aria-live=polite so screen-reader users hear the
        // assistant prose announce as tokens land. aria-relevant=text
        // limits announcements to the streamed content; additions
        // covers the bubble-mount edge case.
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          // v1.18.7 — a soft fade/slide-in on the assistant turn so the
          // hand-off from the thinking beat to the first streamed tokens
          // reads as one continuous motion, not a hard swap. v1.18.9 — the
          // per-word fade now lives in <StreamedProse>; this stays a light
          // container fade for the disclosure → prose transition.
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
        >
          <ChatBubble
            role="assistant"
            content={streaming.content}
            metricSource={streaming.metricSource}
            suggestion={streaming.suggestion}
            suggestedAction={streaming.suggestedAction}
            providerType={streaming.inProgress ? "streaming" : null}
            inProgress={streaming.inProgress}
            errorCode={streaming.errorCode}
            // v1.18.9 — live word-fade + the just-landed token footer.
            streaming
            usage={streaming.usage}
          />
        </div>
      )}
      {/* v1.16.5 — thread tail: the current guided question and/or the
          closing summary follow the last completed turn. */}
      {placement.tail.map((i) => (
        <Fragment key={i.key}>{i.node}</Fragment>
      ))}
    </div>
  );
}

interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  metricSource?: import("@/lib/ai/coach/types").CoachProvenance | null;
  /**
   * v1.18.1 (Workstream C) — live cadence suggestion from the streaming
   * hook. Persisted messages carry it on `metricSource.suggestion`
   * instead; the bubble falls back to that so the card survives reload.
   */
  suggestion?: import("@/lib/ai/coach/types").CoachSuggestion | null;
  /**
   * v1.22 (W7/W6) — live generalised confirm-card action from the streaming
   * hook. Persisted messages carry it on `metricSource.suggestedAction`; the
   * bubble falls back to that so the card survives reload.
   */
  suggestedAction?:
    import("@/lib/ai/coach/suggest-action").CoachSuggestedAction | null;
  providerType?: string | null;
  inProgress?: boolean;
  errorCode?: string | null;
  /**
   * v1.4.23 H7 — present only on persisted assistant messages.
   * Streaming bubbles (no message id yet) skip the thumbs row so the
   * user can't rate before the message lands on disk.
   */
  messageId?: string;
  /**
   * v1.18.9 — true for the live streaming assistant turn. Drives the
   * word-by-word prose fade (`<StreamedProse>`); persisted bubbles render
   * settled plain text.
   */
  streaming?: boolean;
  /**
   * v1.18.9 — per-turn token usage for the just-finished streaming bubble
   * (from `done.usage`). Persisted bubbles read `tokensUsed` / `model`
   * instead.
   */
  usage?: import("./use-coach").CoachUsage | null;
  /**
   * v1.18.9 — persisted per-message token count + model, for the quiet
   * token footer on reload. Null on user turns, refusals, and older rows.
   */
  tokensUsed?: number | null;
  model?: string | null;
  /**
   * v1.22 (W5) — ISO creation timestamp for the persisted bubble's
   * hover/tap timestamp tooltip. Absent on optimistic + streaming bubbles
   * (no persisted time yet), so those render no timestamp.
   */
  createdAt?: string;
  /**
   * v1.22 — bound "Try again" callback for a settled assistant turn (the
   * thread closes over the preceding user message). Absent on user / streaming
   * / refusal turns and when the surface supplies no regenerate handler.
   */
  onRegenerate?: () => void;
}

function ChatBubble({
  role,
  content,
  metricSource,
  suggestion,
  suggestedAction,
  providerType,
  inProgress,
  errorCode,
  messageId,
  streaming,
  usage,
  tokensUsed,
  model,
  createdAt,
  onRegenerate,
}: ChatBubbleProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // v1.4.27 B7 / L3 — pair the evidence `<details>` and its disclosed
  // list explicitly so screen-readers announce the panel relationship.
  const evidencePanelId = useId();
  // v1.4.27 MB3 / CF-32 — track the disclosure state in React so the
  // summary can carry an accurate `aria-expanded`. Native `<details>`
  // reflects its open state via the `open` attribute, but that does
  // not surface as `aria-expanded` on the summary by default; screen
  // readers still need the explicit attribute to announce the panel
  // as expanded vs collapsed.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  if (role === "user") {
    // v1.5.5 — pull the user's self-hosted avatar so the user
    // bubble matches the Coach avatar in size and visual weight.
    // Falls back to initials when the user has not uploaded an
    // avatar. Replaces the Gravatar leak (v1.4.22 B3).
    const avatarUrl = user?.avatarUrl ?? null;
    const initials = user?.username
      ? user.username.slice(0, 2).toUpperCase()
      : null;
    return (
      <div
        data-slot="coach-bubble-user"
        className="flex items-start justify-end gap-2.5"
      >
        <div
          className={cn(
            // Budget the avatar column (size-8 + gap-2.5 ≈ 2.625rem) out
            // of the 80% cap so the bubble + avatar together never
            // overflow a comfortable width on a narrow phone.
            // `group/user-bubble` scopes the remember control's
            // hover/focus reveal (see `RememberUserMessage`).
            "group/user-bubble flex max-w-[calc(80%-2.625rem)] flex-col items-end gap-1",
          )}
        >
          <div
            className={cn(
              "border-dose-accent/30 bg-dose-accent/12 text-foreground",
              "rounded-xl rounded-tr-sm border px-3.5 py-2.5",
              "text-sm leading-relaxed",
            )}
          >
            {/* v1.22 (W5) — render real paragraph blocks so a multi-line
                message reads as paragraphs, not one run-on block. User text
                is verbatim: no chart-token strip, no Learn linkify. */}
            <ProseBlocks text={content} strip={false} linkify={false} />
          </div>
          {/* v1.22 — per-message action row: Copy, then the timestamp
              trailing. Muted until the bubble is hovered / focused on pointer
              devices; always visible on touch (no hover to reveal it). */}
          <div
            data-slot="coach-bubble-actions"
            className={cn(
              "flex items-center justify-end gap-0.5",
              "sm:[@media(hover:hover)]:opacity-0",
              "sm:[@media(hover:hover)]:group-hover/user-bubble:opacity-100",
              "sm:[@media(hover:hover)]:group-focus-within/user-bubble:opacity-100",
              "transition-opacity duration-150 motion-reduce:transition-none",
            )}
          >
            <CopyMessageButton content={content} strip={false} />
            {createdAt && <BubbleTimestamp iso={createdAt} align="end" />}
          </div>
          {/* v1.16.8 — explicit remember control. Stating an allergy in
              chat used to leave no durable trace unless a narrow
              pattern pass happened to match the phrasing; this stores
              the message into the editable self-context (Settings → AI)
              on one tap, so it rides every future system prompt. Only
              persisted messages get the control (an optimistic bubble
              has no id yet), and only when the text fits the
              self-context field cap. */}
          {messageId && content.length <= ABOUT_ME_FIELD_MAX_CHARS && (
            <RememberUserMessage content={content} />
          )}
        </div>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="border-border/50 mt-0.5 size-8 shrink-0 rounded-full border object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            data-slot="coach-bubble-user-avatar"
            className="text-muted-foreground bg-muted/60 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          >
            {initials ?? <User className="size-3.5" />}
          </div>
        )}
      </div>
    );
  }

  // v1.4.25 W5 — map server-emitted error codes to specific Coach
  // i18n keys. Distinct user-quota and provider-rate-limit copy so the
  // user understands daily-cap (resets at UTC midnight) vs. transient
  // provider load (retry in ~5 min). Codes that have no dedicated
  // translation fall back to the generic provider-unavailable copy.
  const errorKey = errorCode ? errorCodeToI18nKey(errorCode) : null;
  const errorMessage = errorKey ? t(errorKey, {}) : null;
  // When a translated message comes back unchanged (i.e. key missing)
  // we fall back to a generic provider error string so the bubble
  // doesn't surface raw `coach.http.503` text to the user.
  const safeError =
    errorMessage && errorMessage !== errorKey
      ? errorMessage
      : errorCode
        ? t("insights.coach.errorProvider")
        : null;

  const keyValues = metricSource?.keyValues ?? [];
  // v1.12.0 — the provenance disclosure surfaces whenever there is any
  // grounding to show: the source chips (metrics/windows) and/or the
  // raw key-values. `SourceChips` itself returns null when the envelope
  // carries neither metric nor window, so we mirror that condition here
  // to decide whether the `<details>` shell renders at all.
  const hasChips =
    !!metricSource &&
    ((metricSource.metrics?.length ?? 0) > 0 ||
      (metricSource.windows?.length ?? 0) > 0);
  const hasProvenance = hasChips || keyValues.length > 0;

  // v1.22 (W5) — Coach charts Phase 1. Render an allowlisted, provenance-
  // grounded `metric:<TYPE>` chart under a SETTLED assistant turn. Skipped
  // while streaming / in-flight / errored / on a refusal; a no-op when no
  // grounded token is present (provider-agnostic — reads the inline token).
  const chartTokens =
    !streaming && !inProgress && !errorCode && providerType !== "refusal"
      ? selectCoachChartTokens(content, metricSource?.metrics)
      : [];

  return (
    <div
      data-slot="coach-bubble-assistant"
      className="group/assistant-bubble flex items-start gap-2.5"
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
      <div className="flex max-w-[calc(80%-2.625rem)] flex-col gap-2">
        {/* v1.19.1 (C3) — the live turn shows the classic typing animation
            (three pulsing dots) while it is still thinking with no prose
            yet, restoring the writing/typing indicator the maintainer
            prefers over the "Denke nach / Nachgedacht" reasoning disclosure.
            The dots render inside the prose bubble below; the disclosure is
            retired. Persisted bubbles never stream, so history stays settled. */}
        {/* The prose bubble. While the live turn is still thinking with no
            prose the bubble carries the typing animation; once tokens land
            it swaps to the streamed prose without a layout jump. */}
        {(content || safeError || inProgress) && (
          <div
            className={cn(
              "border-border/60 bg-muted/40 text-foreground",
              "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
              "text-sm leading-relaxed whitespace-pre-wrap",
            )}
          >
            {/* v1.4.25 W5b — strip stray Metric/enum leak tokens from the
                assistant prose. v1.18.9 — the live turn streams in
                word-by-word with a soft fade (<StreamedProse>); a settled
                / persisted turn renders as plain text. */}
            {/* v1.16.4 — a failed turn with no streamed prose renders the
                error copy INSIDE the bubble; with partial prose the prose
                keeps the bubble and the error stays a caption. */}
            {content ? (
              <StreamedProse content={content} streaming={!!streaming} />
            ) : inProgress ? (
              <TypingDots label={t("insights.coach.thinking")} />
            ) : safeError ? (
              <span className="text-warning/90">{safeError}</span>
            ) : (
              ""
            )}
          </div>
        )}
        {safeError && content && (
          <p className="text-warning/90 text-xs">{safeError}</p>
        )}
        {/* v1.22 (W5) — accompanying chart(s). The token was already
            stripped from the prose by <StreamedProse>; here it mounts the
            real, self-fetching Recharts chart for the user's own series.
            The model never emits data — only a metric identifier from a
            closed allowlist, intersected with the turn's grounded metrics. */}
        {chartTokens.length > 0 && (
          <div data-slot="coach-charts" className="flex w-full flex-col gap-3">
            {chartTokens.map((token) => {
              const metric = tokenToMetric(token);
              return (
                <div
                  key={token}
                  data-slot="coach-chart"
                  className="border-border/60 bg-muted/20 rounded-xl border p-2"
                >
                  <HealthChartDynamic
                    types={[metric]}
                    title={coachChartTitle(metric, t)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {/* v1.18.6 — a "no provider configured anywhere" turn is a
            setup gap, not a transient failure: surface a direct link to
            Settings → AI so the Coach guides the user into BYOK / local
            setup instead of inviting an endless retry. */}
        {errorCode === "coach.provider.none" && (
          <Link
            href="/settings/ai"
            data-slot="coach-no-provider-cta"
            className="text-primary text-xs font-medium underline-offset-4 hover:underline"
          >
            {t("insights.coach.errorNoProviderAction")}
          </Link>
        )}
        {/* v1.12.0 — collapse the whole provenance block ("what was
            included") behind one disclosure, collapsed by default. The
            source chips used to render fully expanded above the
            evidence `<details>`, so the grounding context was often
            taller than the answer itself. Folding the chips + the raw
            key-values into a single closed disclosure keeps the reply
            the focus and lets the user expand the grounding on demand —
            and removes the always-on chip row that duplicated what the
            disclosure already names. The disclosure surfaces whenever
            there is any provenance to show (chips and/or key-values). */}
        {hasProvenance && (
          <details
            data-slot="coach-evidence"
            open={evidenceOpen}
            onToggle={(e) =>
              setEvidenceOpen((e.target as HTMLDetailsElement).open)
            }
            // v1.4.27 F14 — always closed by default. The `open`
            // attribute was previously tied to a per-user pref that
            // surfaced raw values unconditionally; that pref is now
            // retired and the disclosure is a true progressive-
            // disclosure surface — the user clicks to expand.
            //
            // v1.4.27 MB3 / CF-32 — the `open` attribute is now
            // controlled from local state so the summary's
            // `aria-expanded` stays in lock-step. The native disclosure
            // semantics (Enter / Space toggle) are preserved.
            className={cn(
              "border-border/50 bg-muted/30 group rounded-md border",
              "px-2.5 py-1.5 text-xs",
            )}
          >
            <summary
              data-slot="coach-evidence-summary"
              aria-controls={evidencePanelId}
              aria-expanded={evidenceOpen}
              className={cn(
                "text-muted-foreground hover:text-foreground flex cursor-pointer",
                "items-center gap-1.5 leading-relaxed",
                "marker:hidden [&::-webkit-details-marker]:hidden",
                "focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-2",
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-3 transition-transform group-open:rotate-90"
              />
              <span>{t("insights.coach.evidenceLabel")}</span>
            </summary>
            <div
              id={evidencePanelId}
              data-slot="coach-evidence-panel"
              className="mt-2 flex flex-col gap-2"
            >
              {/* v1.12.0 — the source chips now live inside the
                  disclosure so they expand with the rest of the
                  grounding instead of always painting above the
                  answer. */}
              {hasChips && metricSource && (
                <SourceChips provenance={metricSource} />
              )}
              {keyValues.length > 0 && (
                <ul
                  data-slot="coach-evidence-list"
                  className="text-foreground flex flex-col gap-1"
                >
                  {keyValues.map((kv, idx) => (
                    <li
                      key={`${kv.label}-${idx}`}
                      data-slot="coach-evidence-row"
                      className="leading-relaxed"
                    >
                      {/* v1.4.25 W5 — `kv.label` (e.g. "avg7 systolic")
                          was rendered prefixed to every row, repeating
                          framing the disclosure heading already gives.
                          Drop the label and lead with the value; the
                          window stays as a parenthetical tail so the row
                          still answers "over what timeframe?". */}
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
              )}
            </div>
          </details>
        )}
        {/* v1.18.1 (Workstream C) — one-tap cadence-suggestion action
            card. Live from the streaming hook, or restored from the
            persisted message provenance on reload. Not shown on
            in-flight or errored turns. */}
        {!inProgress &&
          !errorCode &&
          (() => {
            const sug = suggestion ?? metricSource?.suggestion ?? null;
            return sug ? <ReminderSuggestionCard suggestion={sug} /> : null;
          })()}
        {/* v1.22 (W7/W6) — generalised confirm-card action. Live from the
            streaming hook, or restored from persisted message provenance on
            reload. Mirrors the reminder-suggestion block above. */}
        {!inProgress &&
          !errorCode &&
          (() => {
            const action =
              suggestedAction ?? metricSource?.suggestedAction ?? null;
            return action ? <SuggestedActionCard action={action} /> : null;
          })()}
        {/* v1.18.9 — quiet per-message token footer. The just-finished
            streaming turn reads the `done.usage` envelope; a persisted /
            reloaded turn reads the message's own `tokensUsed` + `model`.
            Skipped on in-flight, errored, and refusal turns. */}
        {!inProgress && !errorCode && providerType !== "refusal" && (
          <MessageTokenFooter
            tokens={usage?.totalTokens ?? tokensUsed}
            model={usage?.model ?? model}
          />
        )}
        {/* v1.22 — per-message hover action row. Icon-only, muted until the
            bubble is hovered / focused on pointer devices; always visible on
            touch (no hover to reveal it). Copy + Read-aloud + Good / Bad
            feedback + Try-again, with the timestamp trailing. Only settled
            persisted assistant turns get the row (skipped for refusals,
            errors, in-flight stream bubbles). */}
        {!inProgress && !errorCode && providerType !== "refusal" && content && (
          <div
            data-slot="coach-bubble-actions"
            className={cn(
              "flex flex-wrap items-center gap-0.5",
              "sm:[@media(hover:hover)]:opacity-0",
              "sm:[@media(hover:hover)]:group-hover/assistant-bubble:opacity-100",
              "sm:[@media(hover:hover)]:group-focus-within/assistant-bubble:opacity-100",
              "transition-opacity duration-150 motion-reduce:transition-none",
            )}
          >
            <CopyMessageButton content={content} strip />
            {!streaming && <ReadAloudButton content={content} />}
            {messageId && <CoachMessageFeedback messageId={messageId} />}
            {!streaming && onRegenerate && (
              <TryAgainButton onRegenerate={onRegenerate} />
            )}
            {createdAt && <BubbleTimestamp iso={createdAt} />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * v1.16.8 — per-message remember control under the user bubble.
 *
 * One tap stores the message text into the structured self-context via
 * `POST /api/coach/about-me/adopt` (no `question` — the server matches
 * the target field from the text itself: an allergy statement lands on
 * the allergies field, a stated condition on conditions, everything
 * else on the coach-focus slot). The stored text is visible and
 * editable under Settings → AI and rides every future Coach system
 * prompt. Settled states mirror `SelfContextAdoptOffer`: a short
 * confirmation replaces the button after an adoption or a server-side
 * dedupe; a failure surfaces a toast and the button stays tappable.
 */
function RememberUserMessage({ content }: { content: string }) {
  const { t } = useTranslations();
  const [settled, setSettled] = useState<"adopted" | "duplicate" | null>(null);
  // On settle the button unmounts while it holds focus, which would
  // drop keyboard focus to <body>. The confirmation paragraph takes
  // the focus instead (`tabIndex={-1}` + programmatic focus) so the
  // reading position survives the swap.
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (settled) statusRef.current?.focus();
  }, [settled]);

  const remember = useMutation({
    mutationFn: async () => {
      return apiPost<{ adopted: boolean }>("/api/coach/about-me/adopt", {
        answer: content,
      });
    },
    onSuccess: (data) => {
      setSettled(data.adopted ? "adopted" : "duplicate");
    },
    onError: () => {
      toast.error(t("insights.coach.rememberMessage.failed"));
    },
  });

  if (settled) {
    return (
      <p
        role="status"
        ref={statusRef}
        tabIndex={-1}
        data-slot="coach-remember-message-done"
        className="text-muted-foreground flex items-center gap-1 text-xs outline-none"
      >
        <Check className="text-dracula-green size-3" aria-hidden="true" />
        {t(
          settled === "adopted"
            ? "insights.coach.rememberMessage.done"
            : "insights.coach.rememberMessage.duplicate",
        )}
      </p>
    );
  }

  return (
    <button
      type="button"
      data-slot="coach-remember-message"
      onClick={() => remember.mutate()}
      disabled={remember.isPending}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
        "inline-flex min-h-11 items-center gap-1 rounded px-1.5 py-1 text-xs sm:min-h-9",
        "outline-none focus-visible:ring-2 disabled:opacity-50",
        // Calmer thread on pointer devices: the control stays invisible
        // until its bubble is hovered or holds focus. Touch viewports
        // (no hover media) keep it always visible — there is nothing to
        // hover. `opacity-0` (not `invisible`) keeps it focusable so
        // keyboard users can reach it; focus then reveals it.
        "sm:[@media(hover:hover)]:opacity-0",
        "sm:[@media(hover:hover)]:group-hover/user-bubble:opacity-100",
        "sm:[@media(hover:hover)]:group-focus-within/user-bubble:opacity-100",
        "sm:[@media(hover:hover)]:focus-visible:opacity-100",
        "transition-opacity duration-150 motion-reduce:transition-none",
      )}
    >
      {remember.isPending ? (
        <Loader2
          className="size-3 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <BookmarkPlus className="size-3" aria-hidden="true" />
      )}
      {t("insights.coach.rememberMessage.action")}
    </button>
  );
}

/**
 * v1.16.1 — classic chat typing indicator: three dots pulsing in
 * sequence inside the assistant bubble, shown only between submit and
 * the first streamed token. Uses the stock `animate-pulse` keyframe
 * with staggered delays so no custom keyframe is introduced;
 * `motion-reduce` freezes the dots and the `label` stays as the
 * screen-reader text either way.
 *
 * Exported since v1.16.5: the guided clarifying-question bubble replays
 * the same indicator before a deterministic question reveals, so the
 * scripted turns share one rhythm with the streamed ones.
 */
export function TypingDots({ label }: { label: string }) {
  return (
    <span
      data-slot="coach-typing-indicator"
      // v1.21.2.1 — the pre-stream beat shows ONLY the three bouncing dots,
      // no "Thinking…" word. The label stays in an `sr-only` span so the
      // screen-reader still announces the thinking state.
      className="text-muted-foreground inline-flex items-center gap-2 py-0.5"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="bg-dracula-purple/70 size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
            style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
          />
        ))}
      </span>
    </span>
  );
}

interface CoachMessageFeedbackProps {
  messageId: string;
}

function CoachMessageFeedback({ messageId }: CoachMessageFeedbackProps) {
  const { t } = useTranslations();
  const [submittedRating, setSubmittedRating] = useState<
    "helpful" | "unhelpful" | null
  >(null);

  const submit = useMutation({
    mutationFn: async (rating: "helpful" | "unhelpful") => {
      try {
        await apiPost(`/api/insights/chat/messages/${messageId}/feedback`, {
          rating,
        });
      } catch (err) {
        // Treat 409 (already_rated) as a successful no-op so the user
        // never sees an error toast for double-clicking the same chip.
        if (!(err instanceof ApiError && err.status === 409)) {
          throw err;
        }
      }
      return rating;
    },
    onSuccess: (rating) => setSubmittedRating(rating),
    // v1.16.4 — a failed rating used to fail silently; the chips stayed
    // tappable with no signal that nothing was recorded.
    onError: () => {
      toast.error(t("insights.coach.feedbackError"));
    },
  });

  // v1.22 — icon-only feedback in the per-message action row. After a rating
  // lands, the chosen thumb stays visible in its confirming colour (the other
  // is dropped) with an `sr-only` thanks so the signal is legible without a
  // text caption breaking the icon row.
  if (submittedRating) {
    return (
      <span
        data-slot="coach-message-feedback-thanks"
        role="status"
        className="inline-flex items-center"
      >
        <span className="sr-only">{t("insights.coach.feedbackThanks")}</span>
        {submittedRating === "helpful" ? (
          <ThumbsUp className="text-success size-3.5" aria-hidden="true" />
        ) : (
          <ThumbsDown className="text-warning size-3.5" aria-hidden="true" />
        )}
      </span>
    );
  }

  const helpfulLabel = t("insights.coach.feedbackHelpful");
  const unhelpfulLabel = t("insights.coach.feedbackUnhelpful");
  return (
    <div
      data-slot="coach-message-feedback"
      className="inline-flex items-center"
    >
      <button
        type="button"
        data-slot="coach-message-feedback-helpful"
        onClick={() => submit.mutate("helpful")}
        disabled={submit.isPending}
        aria-label={helpfulLabel}
        title={helpfulLabel}
        className={cn(COACH_ICON_BUTTON, "hover:text-success")}
      >
        <ThumbsUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-slot="coach-message-feedback-unhelpful"
        onClick={() => submit.mutate("unhelpful")}
        disabled={submit.isPending}
        aria-label={unhelpfulLabel}
        title={unhelpfulLabel}
        className={cn(COACH_ICON_BUTTON, "hover:text-warning")}
      >
        <ThumbsDown className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
