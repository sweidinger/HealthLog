"use client";

import { useEffect, useState } from "react";

/**
 * Debounces a fast-changing value (typically a search-input draft) so a
 * dependent effect / query key only reacts once the value has settled for
 * `delayMs`. Mirrors the inline 200 ms pattern the Dokumente vault search
 * already used (`documents-view.tsx`), centralised here so other search
 * surfaces (v1.30.2 — the Coach conversation history) don't hand-roll the
 * same timeout.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
