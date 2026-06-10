/**
 * Client-side mirror of the per-user hour-cycle preference.
 *
 * The server-authoritative value lives on the user row (`users.time_format`,
 * surfaced by `/api/auth/me` and editable via the profile PATCH). The mirror
 * follows the `healthlog-locale` pattern: `fetchMe` writes the resolved value
 * into localStorage so that
 *
 *   1. `useFormatters()` can read it through `useSyncExternalStore` without
 *      requiring a QueryClient in the tree, and
 *   2. the legacy helpers in `src/lib/format.ts` (plain functions, no React
 *      context) render the same hour cycle as hook-based call sites.
 *
 * SSR always resolves AUTO (`window` is undefined); the same caveat as the
 * locale formatters applies — current call sites render their formatted
 * strings post-fetch, so there is no hydration-mismatch path today.
 */

import type { TimeFormatPreference } from "./format-locale";

const STORAGE_KEY = "healthlog-time-format";
const CHANGE_EVENT = "healthlog:time-format-change";

export const TIME_FORMAT_PREFERENCES = ["AUTO", "H12", "H24"] as const;

export function isTimeFormatPreference(
  value: unknown,
): value is TimeFormatPreference {
  return (
    typeof value === "string" &&
    (TIME_FORMAT_PREFERENCES as readonly string[]).includes(value)
  );
}

/** Best-effort read of the mirrored preference. AUTO on SSR / no mirror. */
export function readStoredTimeFormat(): TimeFormatPreference {
  if (typeof window === "undefined") return "AUTO";
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    return isTimeFormatPreference(stored) ? stored : "AUTO";
  } catch {
    return "AUTO";
  }
}

/**
 * Persist the mirror and notify same-tab subscribers. Cross-tab updates ride
 * the browser's native `storage` event.
 */
export function storeTimeFormat(value: TimeFormatPreference): void {
  if (typeof window === "undefined") return;
  try {
    const previous = window.localStorage?.getItem(STORAGE_KEY);
    if (previous === value) return;
    window.localStorage?.setItem(STORAGE_KEY, value);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `useSyncExternalStore`-shaped subscription for the mirror. */
export function subscribeTimeFormat(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
