/**
 * Server-side message-bundle map + re-export of the shared key resolver.
 *
 * v1.4.27 B7 / BL-P4-11-S10 — client and server previously each carried
 * their own private copy of `allMessages` plus a near-identical
 * `resolveKey` helper; pinning both to one import stopped the maps
 * drifting when a locale was added.
 *
 * Since the i18n bundle split, `allMessages` is SERVER-ONLY: the root
 * layout picks the active locale's bundle out of it for the RSC handoff
 * and `getServerTranslator()` resolves against it. Do NOT import this
 * module from client code — the six static JSON imports would drag
 * every locale back into the client chunk (the ~1.4 MiB regression the
 * split removed). Client code uses `./load-locale` (static EN fallback
 * floor + dynamic per-locale imports) and `./resolve-key` instead.
 */
import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";
import frMessages from "../../../messages/fr.json";
import esMessages from "../../../messages/es.json";
import itMessages from "../../../messages/it.json";
import plMessages from "../../../messages/pl.json";
import { type Locale } from "./config";

export { resolveKey } from "./resolve-key";

/**
 * Single source of truth for the per-locale message bundle on the
 * server (layout RSC handoff, server translator, jobs).
 */
export const allMessages: Record<Locale, Record<string, unknown>> = {
  de: deMessages,
  en: enMessages,
  fr: frMessages,
  es: esMessages,
  it: itMessages,
  pl: plMessages,
};
