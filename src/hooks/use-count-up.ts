"use client";

import { useEffect, useRef, useState } from "react";

/**
 * v1.10.0 — a tiny zero-dependency count-up animation hook for the
 * score-ring / score-number "sweep to fill on first paint" affordance
 * the premium-health direction calls for. No motion library — ~30 LOC of
 * `requestAnimationFrame` instead, per the 0 KB runtime budget.
 *
 * Returns a number that eases from 0 to `target` once, on mount (and
 * re-runs when `target` changes). Honours `prefers-reduced-motion`: a
 * reduced-motion user (or any environment without rAF, e.g. SSR / the
 * Vitest jsdom render) gets the final value immediately with no
 * intermediate frames — the state is seeded to `target` so no
 * synchronous-in-effect setState is needed for the no-animation path.
 */
export function useCountUp(
  target: number,
  options: {
    durationMs?: number;
    enabled?: boolean;
    startDelayMs?: number;
  } = {},
): number {
  const { durationMs = 600, enabled = true, startDelayMs = 0 } = options;
  // Seed at the final value so the reduced-motion / SSR path is already
  // correct without any setState; only the animated path drives frames,
  // and those setState calls all happen inside the rAF callback (async).
  const [value, setValue] = useState<number>(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (
      !enabled ||
      prefersReduced ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      !Number.isFinite(target)
    ) {
      // The animated path is skipped; the rAF callback below never runs,
      // so the displayed value stays at whatever the last frame / seed
      // left it. Schedule a single async correction in case the previous
      // target differed — done via rAF so it is not a sync-in-effect set.
      if (
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        frameRef.current = window.requestAnimationFrame(() => setValue(target));
        return () => {
          if (frameRef.current != null) {
            window.cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
          }
        };
      }
      return;
    }

    let start = 0;

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / durationMs);
      // ease-out cubic — matches the "never bouncy, ease-out ~300–500ms"
      // motion note in the design direction.
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) {
        frameRef.current = window.requestAnimationFrame(tick);
      } else {
        setValue(target);
      }
    };

    // Hold the number at 0 during the stagger delay so it matches the empty
    // ring, then start the rAF loop. Every setState runs inside a rAF/timeout
    // callback (async) — never synchronously in the effect body — so there is
    // no cascading render. `startDelayMs` lets the strip stagger each tile's
    // count-up so the number trails its arc, left-to-right.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const begin = () => {
      frameRef.current = window.requestAnimationFrame((now) => {
        start = now;
        tick(now);
      });
    };
    const arm = window.requestAnimationFrame(() => {
      setValue(0);
      if (startDelayMs > 0) {
        timeoutId = setTimeout(begin, startDelayMs);
      } else {
        begin();
      }
    });

    return () => {
      window.cancelAnimationFrame(arm);
      if (timeoutId != null) clearTimeout(timeoutId);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [target, durationMs, enabled, startDelayMs]);

  return value;
}
