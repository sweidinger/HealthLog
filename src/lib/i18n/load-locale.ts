/**
 * Client-side message-bundle loading.
 *
 * Only English ships statically in the client chunk — it is the
 * synchronous fallback floor of the t() chain (active locale → EN →
 * raw key) and the bundle the provider can always resolve against
 * without an async gap. Every other locale reaches the client one of
 * two ways:
 *
 *   1. First paint: the root layout (a server component) resolves the
 *      active locale from the `healthlog-locale` cookie / the
 *      Accept-Language header and threads that locale's messages into
 *      `I18nProvider` as a serialized RSC prop — so the first client
 *      render already holds the right bundle and there is no EN→DE
 *      hydration flash (the historical reason all six bundles used to
 *      ship statically).
 *   2. Locale switch: `loadMessages()` dynamic-imports the target
 *      bundle on demand; each locale becomes its own async chunk that
 *      only the users who switch to it ever download.
 *
 * The module-level cache makes repeat switches instant and lets the
 * provider seed it with the server-passed bundle (`primeMessages`).
 */
import enMessages from "../../../messages/en.json";
import { type Locale } from "./config";

export type MessageBundle = Record<string, unknown>;

/** Synchronous fallback floor — always available, never awaited. */
export const fallbackMessages: MessageBundle = enMessages;

const loaders: Record<Locale, () => Promise<{ default: MessageBundle }>> = {
  de: () => import("../../../messages/de.json"),
  en: () => import("../../../messages/en.json"),
  fr: () => import("../../../messages/fr.json"),
  es: () => import("../../../messages/es.json"),
  it: () => import("../../../messages/it.json"),
  pl: () => import("../../../messages/pl.json"),
};

const cache: Partial<Record<Locale, MessageBundle>> = { en: enMessages };

export function getCachedMessages(locale: Locale): MessageBundle | undefined {
  return cache[locale];
}

/** Seed the cache with a bundle that arrived as a server prop. */
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
