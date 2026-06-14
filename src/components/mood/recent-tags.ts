"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * v1.17.0 — most-recently-used mood-tag tracking for the Quick row.
 *
 * The Quick row surfaces the caller's handful of most-recently-used binary
 * tags as one-tap chips so the common case (a face + a couple of familiar
 * tags + Save) is genuinely fast. The MRU order is a small, client-only
 * convenience persisted in `localStorage`; it never touches the API and a
 * cleared store simply degrades to "no quick chips yet".
 *
 * The selection logic is split out as pure functions so it is unit-testable
 * without a DOM.
 */

const STORAGE_KEY = "healthlog:mood:recent-tags";
const MAX_RECENT = 24;

/**
 * Promote `usedKeys` to the front of the existing MRU list (most-recent
 * first), de-duplicated, capped at `MAX_RECENT`. A key already present is
 * moved to the front rather than duplicated. Order within `usedKeys` is
 * preserved (first item ends up most-recent).
 */
export function promoteRecentTags(
  existing: readonly string[],
  usedKeys: readonly string[],
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  // Most-recent first: the latest-used keys lead, then prior history.
  for (const key of [...usedKeys].reverse().concat(existing)) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
    if (next.length >= MAX_RECENT) break;
  }
  return next;
}

/**
 * Resolve the ordered Quick-row keys for a render: the MRU keys that still
 * exist in the live catalog (intersected so a deleted tag drops out), capped
 * at `limit`. When the user has no history yet, fall back to the first
 * `limit` catalog keys so the Quick row is never empty on a fresh account.
 */
export function selectQuickTagKeys(
  recent: readonly string[],
  catalogKeys: readonly string[],
  limit: number,
): string[] {
  const catalogSet = new Set(catalogKeys);
  const fromHistory = recent.filter((k) => catalogSet.has(k));
  if (fromHistory.length >= limit) return fromHistory.slice(0, limit);
  // Top up with catalog keys not already chosen so the row stays full.
  const chosen = new Set(fromHistory);
  const topped = [...fromHistory];
  for (const key of catalogKeys) {
    if (topped.length >= limit) break;
    if (!chosen.has(key)) {
      chosen.add(key);
      topped.push(key);
    }
  }
  return topped.slice(0, limit);
}

const EMPTY: string[] = [];
// Cache the parsed snapshot so `useSyncExternalStore` gets a stable
// reference between reads (a fresh array every call would loop forever).
let snapshot: string[] = EMPTY;
let snapshotRaw: string | null | undefined;

function readStore(): string[] {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === snapshotRaw) return snapshot;
  snapshotRaw = raw;
  if (!raw) {
    snapshot = EMPTY;
    return snapshot;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    snapshot = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : EMPTY;
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  for (const cb of listeners) cb();
}

/**
 * React hook over the MRU store. Reads the persisted keys via
 * `useSyncExternalStore` (SSR-safe: the server snapshot is empty and
 * hydration stays stable), and exposes a `recordUse` to promote
 * freshly-saved tag keys to the front.
 */
export function useRecentTags(): {
  recent: string[];
  recordUse: (usedKeys: readonly string[]) => void;
} {
  const recent = useSyncExternalStore(subscribe, readStore, () => EMPTY);

  const recordUse = useCallback((usedKeys: readonly string[]) => {
    if (usedKeys.length === 0 || typeof window === "undefined") return;
    const next = promoteRecentTags(readStore(), usedKeys);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage full / disabled — nothing to promote */
      return;
    }
    // Invalidate the cached snapshot and notify subscribers to re-read.
    snapshotRaw = undefined;
    emit();
  }, []);

  return { recent, recordUse };
}
