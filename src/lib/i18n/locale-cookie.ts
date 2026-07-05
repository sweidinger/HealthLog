import type { cookies } from "next/headers";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import type { Locale } from "@/lib/i18n/config";

/**
 * The SSR handoff cookie for the active UI locale. The client-side
 * switcher writes it via `document.cookie` (src/lib/i18n/context.tsx),
 * but Safari's ITP caps script-written cookies at 7 days — a user who
 * doesn't open the app for a week silently falls back to the browser
 * language on first paint. Server-side `Set-Cookie` writes are exempt
 * from that cap, so every server seam that knows the persisted locale
 * re-emits the cookie through this one helper.
 */
export const LOCALE_COOKIE = "healthlog-locale";

// One year — mirrors the client-side `persistLocale` write.
const LOCALE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Emit the locale cookie server-side. Throws when the cookie store is
 * read-only (server-component render) — callers on that path catch and
 * skip; the next route-handler request re-attempts.
 */
export function setLocaleCookie(cookieStore: CookieStore, locale: Locale) {
  cookieStore.set(LOCALE_COOKIE, locale, {
    // NOT HttpOnly — the client reads it (format helpers, hydration
    // handoff in src/lib/format.ts and i18n/context.tsx).
    httpOnly: false,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: LOCALE_COOKIE_MAX_AGE_S,
    path: "/",
  });
}
