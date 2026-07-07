/**
 * Client-side message-bundle loading.
 *
 * NO catalog ships statically in the client chunk — not even English.
 * The static EN import that used to live here was the single largest
 * every-route client cost (334 KB raw / ~106 KB gz on every page load,
 * for every user, in every language). The t() chain (active locale →
 * EN → raw key) now resolves its bundles through three paths:
 *
 *   1. SSR pass: this module seeds its cache with the full server-side
 *      catalog map (`shared-resolve`) inside a `typeof window ===
 *      "undefined"` branch. Turbopack compiles the branch away for the
 *      browser bundle (verified — zero catalog bytes reach any client
 *      chunk), while the server render of every client component
 *      resolves the active locale synchronously — SSR text stays
 *      correct with nothing serialized into the flight payload (the
 *      previous RSC-prop handoff inlined the whole active catalog into
 *      EVERY document: 392 KB of a 505 KB dashboard HTML).
 *   2. First client paint: the root layout emits a deferred, versioned,
 *      immutable-cacheable `<script src="/i18n/<locale>?v=…">` that
 *      assigns `self.__HL_I18N` before Next's hydration scripts run.
 *      The initializer below reads it — the first client render holds
 *      the same bundle the server rendered with (no EN→DE hydration
 *      flash), and repeat visits serve the catalog from HTTP/SW cache
 *      instead of re-downloading it inside each document.
 *   3. Locale switch / EN fallback: `loadMessages()` dynamic-imports
 *      the target bundle on demand; each locale becomes its own async
 *      chunk that only the users who need it ever download.
 *
 * The module-level cache makes repeat switches instant and lets tests
 * seed bundles directly (`primeMessages`).
 */
import { type Locale } from "./config";

export type MessageBundle = Record<string, unknown>;

/** Shape of the boot global the /i18n/<locale> script assigns. */
interface I18nBootGlobal {
  locale?: string;
  messages?: MessageBundle;
}

const loaders: Record<Locale, () => Promise<{ default: MessageBundle }>> = {
  de: () => import("../../../messages/de.json"),
  en: () => import("../../../messages/en.json"),
  fr: () => import("../../../messages/fr.json"),
  es: () => import("../../../messages/es.json"),
  it: () => import("../../../messages/it.json"),
  pl: () => import("../../../messages/pl.json"),
};

function initialCache(): Partial<Record<Locale, MessageBundle>> {
  if (typeof window === "undefined") {
    // Server pass (SSR of client components): seed every locale from the
    // server-side catalog map. The branch is dead code in the browser
    // bundle — Turbopack eliminates it together with the require, so none
    // of the six catalogs reaches a client chunk. The try/catch covers
    // non-bundled node runtimes (vitest transforms this module to ESM,
    // where a bare require of a TS module throws) — there the cache starts
    // empty and `vitest.setup.ts` primes every bundle up front.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { allMessages } =
        require("./shared-resolve") as typeof import("./shared-resolve");
      return { ...allMessages };
    } catch {
      return {};
    }
  }
  // Browser: the deferred boot script (emitted by the root layout ahead of
  // the hydration scripts) has already assigned the active locale's bundle.
  const boot = (self as { __HL_I18N?: I18nBootGlobal }).__HL_I18N;
  if (
    boot &&
    typeof boot.locale === "string" &&
    boot.messages &&
    typeof boot.messages === "object"
  ) {
    return { [boot.locale as Locale]: boot.messages };
  }
  return {};
}

const cache: Partial<Record<Locale, MessageBundle>> = initialCache();

export function getCachedMessages(locale: Locale): MessageBundle | undefined {
  return cache[locale];
}

/**
 * The EN fallback floor of the t() chain, when it is already in hand —
 * always on the server, on the client once EN is the active/boot locale or
 * `loadMessages("en")` has resolved. `undefined` means "not loaded yet";
 * callers kick off the async load and re-render when it lands.
 */
export function getFallbackMessages(): MessageBundle | undefined {
  return cache.en;
}

/** Seed the cache with a bundle that arrived out of band (tests, boot). */
export function primeMessages(locale: Locale, messages: MessageBundle): void {
  cache[locale] = messages;
}

export async function loadMessages(locale: Locale): Promise<MessageBundle> {
  const cached = cache[locale];
  if (cached) return cached;
  const mod = await loaders[locale]();
  cache[locale] = mod.default;
  return mod.default;
}
