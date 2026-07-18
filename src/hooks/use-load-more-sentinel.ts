"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * IntersectionObserver-driven "load more" sentinel for a scrollable list
 * backed by `useInfiniteQuery`. Mount the returned ref on an empty element
 * at the end of the rendered list; once it scrolls into `root` (the list's
 * own scroll container — pass `null` to watch the viewport instead),
 * `onLoadMore` fires. Gated by `enabled` so an in-flight fetch or an
 * exhausted list (no `nextCursor`) never re-triggers.
 *
 * v1.30.2 — extracted for the Coach conversation history (rail + the
 * standalone `/coach/conversations` page), which both need the same
 * scroll-to-load-more behaviour the Dokumente vault timeline gets from its
 * `@tanstack/react-virtual` windowing; a virtualizer would be overkill here
 * (conversation counts don't approach document-vault scale), so this is the
 * plain-DOM equivalent of that same "pull the next page near the end of the
 * window" contract.
 */
export function useLoadMoreSentinel({
  enabled,
  onLoadMore,
  root = null,
}: {
  /** True only when there IS a next page and no fetch is already in flight. */
  enabled: boolean;
  onLoadMore: () => void;
  /** Scroll container to observe within; `null` watches the viewport. */
  root?: Element | null;
}): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Latest-callback-wins ref so the observer callback never captures a stale
  // `onLoadMore` closure without having to re-create the observer on every
  // render.
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!enabled) return;
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { root, rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, root]);

  return sentinelRef;
}
