"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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
import { allMessages, resolveKey } from "./shared-resolve";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
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
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    // Prefer the server-resolved initial locale to eliminate the hydration
    // flash where the server renders EN ("Loading…") and the client then
    // flips to DE ("Laden…") once localStorage/cookie is read at mount.
    if (
      initialLocale &&
      (locales as readonly string[]).includes(initialLocale)
    ) {
      return initialLocale;
    }
    return getSavedLocale() ?? detectSystemLocale();
  });

  const setLocale = useCallback((newLocale: Locale) => {
    if ((locales as readonly string[]).includes(newLocale)) {
      setLocaleState(newLocale);
      localStorage.setItem("healthlog-locale", newLocale);
      // Also mirror to cookie so SSR (layout, metadata) renders in the
      // user's language. 1-year expiry, Lax samesite, not HttpOnly so the
      // client continues to own it.
      document.cookie = `healthlog-locale=${newLocale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      document.documentElement.lang = newLocale;
    }
  }, []);

  // Keep the HTML lang and the cookie in sync with the active locale on
  // mount. The cookie acts as the SSR handoff for the next request.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.cookie = `healthlog-locale=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = resolveKey(allMessages[locale], key);

      // Fallback to English if key missing in current locale
      if (value === undefined && locale !== "en") {
        value = resolveKey(allMessages.en, key);
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
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
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
