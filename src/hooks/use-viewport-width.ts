"use client";

import { useEffect, useState } from "react";

import { getViewportWidth } from "@/lib/charts/x-axis-density";

/**
 * Reactive viewport-width hook. SSR-safe — returns the desktop default
 * on the server (so charts paint with desktop tick density on first
 * paint and progressively enhance once mounted) and updates on window
 * resize / orientation change in the browser.
 *
 * Used by the chart wrappers to drive the v1.4.19 universal x-axis
 * tick-density helper. Lightweight — single resize listener, no
 * debounce because Recharts already memoises its tick render and a
 * resize event fires at most a few times per second.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() => getViewportWidth());

  useEffect(() => {
    const handler = () => setWidth(getViewportWidth());
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("orientationchange", handler);
    };
  }, []);

  return width;
}
