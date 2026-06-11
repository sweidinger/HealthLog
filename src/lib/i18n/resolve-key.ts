/**
 * Resolve a dotted key (`nav.dashboard`) inside a flat-or-nested
 * message object. Returns `undefined` when the key path doesn't land
 * on a string leaf so the caller can chain a fallback bundle (English,
 * raw key) without ambiguity.
 *
 * Lives in its own module (no message-bundle imports) so the client
 * provider can use it without pulling every locale JSON into the
 * client chunk — `shared-resolve.ts` keeps the full bundle map for
 * server-side callers and re-exports this helper.
 */
export function resolveKey(
  messages: Record<string, unknown>,
  key: string,
): string | undefined {
  const parts = key.split(".");
  let current: unknown = messages;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}
