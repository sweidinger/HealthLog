"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { stripChartTokens } from "@/lib/insights/chart-tokens";

/**
 * v1.18.9 — Claude-style word-by-word fade-in for the LIVE Coach turn.
 *
 * The provider clients return the whole reply in one shot; the chat route
 * re-chunks it into per-word `token` SSE frames (`tokeniseForStreaming`),
 * so `content` grows as frames land. This component renders each
 * whitespace segment as its own `<span>` that fades + drifts up on mount,
 * giving the reply a "thinking out loud" cadence rather than a hard dump
 * of word groups. Once the turn settles (`streaming === false`) the spans
 * collapse to a single plain-text node — zero residual animation DOM, and
 * the feedback / evidence layout underneath stays stable.
 *
 * Why no "only animate the new words" bookkeeping: each segment is keyed
 * by its index, so when a fresh SSE frame appends words, React keeps the
 * already-mounted spans (their CSS entrance already ran and does not
 * replay on reconcile) and only MOUNTS the new trailing spans — which is
 * exactly when the `animate-in` entrance fires. The browser does the
 * "new words only" gating for us; no render-time ref is needed.
 *
 * CSP-safe: the entrance is Tailwind's `animate-in fade-in-0
 * slide-in-from-bottom-1` (compiled utilities served from `'self'`) plus a
 * per-span inline `animationDelay` / `animationDuration`. Inline `style`
 * attributes are already permitted under the strict CSP
 * (`style-src 'self' 'unsafe-inline'`); there is no runtime-injected
 * `<style>` tag, no `dangerouslySetInnerHTML`, and no markdown library —
 * the text renders as plain React children, the XSS-safe path the rest of
 * the Coach uses.
 *
 * `prefers-reduced-motion`: the animation classes are `motion-safe:`
 * gated, so reduced-motion users get the words instantly with no fade and
 * no translate.
 */
export interface StreamedProseProps {
  /** Raw assistant prose (may contain stray chart-token leaks). */
  content: string;
  /**
   * True while the turn is still streaming. When false the prose renders
   * settled as one plain-text node (persisted history + finished turns).
   */
  streaming: boolean;
}

/**
 * Split prose into word+trailing-whitespace segments. Mirrors the route's
 * server-side `tokeniseForStreaming` split (`\S+\s*`) so the client-side
 * re-split lines up with how the SSE frames arrived. Exported for tests.
 */
export function splitProseSegments(text: string): string[] {
  return text.match(/\S+\s*/g) ?? (text ? [text] : []);
}

export function StreamedProse({ content, streaming }: StreamedProseProps) {
  const clean = stripChartTokens(content);
  const segments = useMemo(
    () => (streaming ? splitProseSegments(clean) : []),
    [streaming, clean],
  );

  if (!streaming) {
    // Settled turn: one plain text node, no spans, no animation.
    return <>{clean}</>;
  }

  return (
    <>
      {segments.map((segment, index) => (
        // New trailing spans mount + animate; already-mounted spans keep
        // their stable index key and do not replay the entrance.
        <span
          key={index}
          className={cn(
            "motion-safe:animate-in motion-safe:fade-in-0",
            "motion-safe:slide-in-from-bottom-1",
          )}
          style={{
            animationDuration: "340ms",
            // A gentle, capped stagger keyed off the in-batch position so a
            // burst of words reads as a soft cascade rather than a single
            // flash, without lagging on a long frame.
            animationDelay: `${(index % 6) * 26}ms`,
            animationFillMode: "both",
          }}
        >
          {segment}
        </span>
      ))}
    </>
  );
}
