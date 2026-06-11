"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { locales, defaultLocale, type Locale } from "./config";
import {
  makeFormatters,
  type Formatters,
  type TimeFormatPreference,
} from "../format-locale";
import {
  readStoredTimeFormat,
  subscribeTimeFormat,
} from "../time-format";
import { resolveKey } from "./resolve-key";
import {
  fallbackMessages,
  getCachedMessages,
  loadMessages,
  primeMessages,
  type MessageBundle,
} from "./load-locale";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * Non-null while a locale switch is waiting on its message bundle
   * (dynamic import). The switcher uses it for a short pending state;
   * `locale` / `t` only flip once the bundle is in so the UI never
   * renders the new locale with the old (or fallback) strings.
   */
  pendingLocale: Locale | null;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectSystemLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const browserLang = navigator.language.split("-")[0];
  return (locales as readonly string[]).includes(browserLang)
    ? (browserLang as Locale)
    : defaultLocale;
}

function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)healthlog-locale=([^;]+)/);
  const value = match?.[1];
  if (value && (locales as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return null;
}

function getSavedLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  // Cookie wins over localStorage: the root layout already rendered the
  // server HTML using the cookie, so matching the cookie on first client
  // render avoids a hydration flash of the wrong language.
  const fromCookie = readLocaleCookie();
  if (fromCookie) return fromCookie;
  const saved = localStorage.getItem("healthlog-locale");
  if (saved && (locales as readonly string[]).includes(saved)) {
    return saved as Locale;
  }
  return null;
}

export function I18nProvider({
  children,
  initialLocale,
  initialMessages,
}: {
  children: ReactNode;
  initialLocale?: Locale;
  /**
   * The active locale's message bundle, resolved server-side by the
   * root layout and passed through the RSC payload. This is what keeps
   * the client chunk free of every non-EN bundle WITHOUT reintroducing
   * the EN→DE hydration flash: the first client render already holds
   * the right strings, no async fetch on first paint. Only EN ships
   * statically (the synchronous fallback floor of the t() chain).
   */
  initialMessages?: MessageBundle;
}) {
  // Locale + messages live in ONE state cell so a locale switch flips
  // both atomically — `locale` never points at a bundle that hasn't
  // arrived yet.
  const [active, setActive] = useState<{
    locale: Locale;
    messages: MessageBundle;
  }>(() => {
    // Prefer the server-resolved initial locale to eliminate the hydration
    // flash where the server renders EN ("Loading…") and the client then
    // flips to DE ("Laden…") once localStorage/cookie is read at mount.
    const locale =
      initialLocale && (locales as readonly string[]).includes(initialLocale)
        ? initialLocale
        : (getSavedLocale() ?? detectSystemLocale());
    if (initialMessages && locale === initialLocale) {
      // Seed the switch cache too, so switching away and back is instant.
      // Idempotent, so safe under StrictMode's double initializer call.
      primeMessages(locale, initialMessages);
      return { locale, messages: initialMessages };
    }
    return { locale, messages: getCachedMessages(locale) ?? fallbackMessages };
  });
  const { locale, messages } = active;
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  // Tracks the most recent switch request so a slow bundle load can't
  // clobber a newer one (last click wins).
  const requestedLocaleRef = useRef<Locale | null>(null);

  // Degenerate mount (no server-passed bundle, non-EN locale from
  // localStorage / navigator): backfill the bundle asynchronously. In
  // the app this path never runs — the root layout always passes the
  // active locale's messages — but standalone mounts stay correct.
  useEffect(() => {
    if (getCachedMessages(locale)) return;
    let cancelled = false;
    void loadMessages(locale).then((loaded) => {
      if (cancelled) return;
      setActive((prev) =>
        prev.locale === locale ? { locale, messages: loaded } : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    if (!(locales as readonly string[]).includes(newLocale)) return;
    localStorage.setItem("healthlog-locale", newLocale);
    // Also mirror to cookie so SSR (layout, metadata) renders in the
    // user's language. 1-year expiry, Lax samesite, not HttpOnly so the
    // client continues to own it.
    document.cookie = `healthlog-locale=${newLocale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    document.documentElement.lang = newLocale;

    const cached = getCachedMessages(newLocale);
    if (cached) {
      requestedLocaleRef.current = null;
      setPendingLocale(null);
      setActive({ locale: newLocale, messages: cached });
      return;
    }

    requestedLocaleRef.current = newLocale;
    setPendingLocale(newLocale);
    loadMessages(newLocale)
      .then((loaded) => {
        if (requestedLocaleRef.current !== newLocale) return;
        requestedLocaleRef.current = null;
        setPendingLocale(null);
        setActive({ locale: newLocale, messages: loaded });
      })
      .catch(() => {
        // Bundle fetch failed (offline mid-session, …) — stay on the
        // current locale rather than rendering the new one in EN.
        if (requestedLocaleRef.current !== newLocale) return;
        requestedLocaleRef.current = null;
        setPendingLocale(null);
      });
  }, []);

  // Keep the HTML lang and the cookie in sync with the active locale on
  // mount. The cookie acts as the SSR handoff for the next request.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.cookie = `healthlog-locale=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = resolveKey(messages, key);

      // Fallback to English if key missing in current locale
      if (value === undefined && locale !== "en") {
        value = resolveKey(fallbackMessages, key);
      }

      // Fallback to key itself
      if (value === undefined) {
        return key;
      }

      // Replace {param} placeholders
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }

      return value;
    },
    [locale, messages],
  );

  const value = useMemo(
    () => ({ locale, setLocale, pendingLocale, t }),
    [locale, setLocale, pendingLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslations() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslations must be used within I18nProvider");
  }
  return context;
}

/**
 * The user's hour-cycle preference (AUTO / H12 / H24), reactive to changes.
 * Backed by the localStorage mirror that `useAuth`'s `/api/auth/me` fetch
 * and the profile time-format select keep in sync with the server value —
 * no QueryClient required in the tree. SSR resolves AUTO.
 */
export function useTimeFormatPreference(): TimeFormatPreference {
  return useSyncExternalStore(
    subscribeTimeFormat,
    readStoredTimeFormat,
    () => "AUTO" as const,
  );
}

/**
 * Locale-aware formatters tied to the active UI locale. Use for every number,
 * date, and time rendered in the UI so regional conventions (70,5 vs 70.5,
 * 19.02.2026 vs Feb 19, 2026) follow the user's language choice. Times honour
 * the per-user hour-cycle preference (AUTO follows the locale, H12 / H24 pin
 * the cycle).
 */
export function useFormatters(): Formatters {
  const { locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();
  return useMemo(
    () => makeFormatters(locale, undefined, timeFormat),
    [locale, timeFormat],
  );
}
