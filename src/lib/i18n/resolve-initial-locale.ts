import { headers, cookies } from "next/headers";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";
import { LOCALE_COOKIE } from "@/lib/i18n/locale-cookie";
import { getSessionUserLocale } from "@/lib/auth/session";

/**
 * First-paint locale ladder for the root layout:
 *
 *   1. `healthlog-locale` cookie — the SSR handoff the client writes on
 *      every switch and the server re-emits on session touch.
 *   2. `User.locale` — the persisted preference. Consulted only on a
 *      cookie miss (Safari ITP expires the script-written cookie after
 *      7 days; without this step the app fell back to the browser
 *      language once a week even though the user had chosen one).
 *   3. Accept-Language — users who never chose stay on the browser
 *      language ("automatic").
 *
 * Fail-soft throughout: cookies()/headers() can throw
 * (DynamicServerError, …) and the session read can hit a DB hiccup — a
 * locale resolution problem must never crash the root layout into
 * global-error.tsx.
 */
export async function resolveInitialLocale(): Promise<Locale> {
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
    if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
      return cookieLocale as Locale;
    }

    let userLocale: string | null = null;
    try {
      userLocale = await getSessionUserLocale();
    } catch {
      // DB hiccup — fall through to Accept-Language rather than "en".
    }
    if (userLocale && (locales as readonly string[]).includes(userLocale)) {
      return userLocale as Locale;
    }

    const headerList = await headers();
    return parseLocaleFromAcceptLanguage(headerList.get("accept-language"));
  } catch {
    return "en";
  }
}
