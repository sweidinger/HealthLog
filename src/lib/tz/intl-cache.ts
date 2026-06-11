/**
 * Module-level memo for `Intl.DateTimeFormat` construction.
 *
 * Constructing a formatter resolves locale + timezone data on every call
 * and dominates the CPU cost of the wall-clock helpers (~10x the
 * `format` / `formatToParts` call it feeds). The instances are stateless
 * for `format` / `formatToParts`, so one shared formatter per
 * `(locale, timeZone, options)` signature is safe to hand to every
 * caller — compliance band expansion, rollups, the dose-history ledger
 * and the export formatters all hit the same small set of signatures.
 *
 * `timeZone` is a first-class key segment (not folded into `options`) so
 * call sites can hoist their options object to a module constant; a
 * WeakMap memoises that constant's serialised signature, leaving a warm
 * lookup as two string concats + one Map get.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Hard cap. The realistic population is bounded (valid IANA zones × a
 * handful of option shapes), but the timezone segment is user-supplied
 * upstream of validation in `isValidTimezone`, so the memo carries a
 * safety valve: on overflow the single OLDEST entry is evicted (Map
 * iteration order is insertion order, so the first key is the oldest).
 * A full-map reset on every insert past the cap would let one burst of
 * unusual zones re-pay formatter construction for every hot signature.
 */
const MAX_FORMATTERS = 1000;

const signatureByOptions = new WeakMap<
  Omit<Intl.DateTimeFormatOptions, "timeZone">,
  string
>();

function optionsSignature(
  options: Omit<Intl.DateTimeFormatOptions, "timeZone">,
): string {
  const memoised = signatureByOptions.get(options);
  if (memoised !== undefined) return memoised;
  const record = options as Record<string, unknown>;
  const signature = Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join(",");
  signatureByOptions.set(options, signature);
  return signature;
}

/**
 * Shared, memoised `Intl.DateTimeFormat`. Throws (like the constructor)
 * on an invalid `timeZone` — failures are never cached, so
 * `isValidTimezone` can probe through this without poisoning the map.
 */
export function getDateTimeFormat(
  locale: string,
  timeZone: string | undefined,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {},
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone ?? ""}|${optionsSignature(options)}`;
  const hit = formatterCache.get(key);
  if (hit) return hit;
  const formatter = new Intl.DateTimeFormat(
    locale,
    timeZone === undefined ? options : { ...options, timeZone },
  );
  if (formatterCache.size >= MAX_FORMATTERS) {
    const oldest = formatterCache.keys().next().value;
    if (oldest !== undefined) formatterCache.delete(oldest);
  }
  formatterCache.set(key, formatter);
  return formatter;
}

/** Test-only escape hatch — clear the memo between assertions. */
export function __resetIntlCacheForTests(): void {
  formatterCache.clear();
}

/** Test-only introspection — current memo population. */
export function __intlCacheSizeForTests(): number {
  return formatterCache.size;
}
