/**
 * Opaque cursor pagination for the MCP reads.
 *
 * The MCP spec models pagination as an OPAQUE, server-chosen cursor token: the
 * client must treat it as a black box, never parse or synthesise it, and pass it
 * back verbatim to fetch the next page. These helpers encode a simple offset into
 * a base64url token so a client cannot construct a cursor by hand or smuggle a
 * different shape through it. The encoding is stable — the same offset always
 * yields the same token — and decoding is fail-safe: any malformed, foreign, or
 * absent cursor decodes to offset 0 (the first page) rather than throwing, so a
 * bad cursor degrades to "start over" instead of breaking the read.
 *
 * The cursor carries ONLY a non-negative integer offset. It is not signed and
 * not user-scoped because it leaks nothing: the offset is meaningless without the
 * session-narrowed query it pages, and every read already feeds `ctx.userId` into
 * the Prisma `where` — a replayed cursor can only re-page the SAME caller's data.
 */

/** Encode a non-negative offset into an opaque base64url cursor token. */
export function encodeOffsetCursor(offset: number): string {
  const safe = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return Buffer.from(JSON.stringify({ o: safe }), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor back to its offset. Returns 0 for a missing,
 * malformed, or foreign cursor so a bad token degrades to the first page rather
 * than throwing.
 */
export function decodeOffsetCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "o" in parsed &&
      typeof (parsed as { o: unknown }).o === "number"
    ) {
      const o = (parsed as { o: number }).o;
      return Number.isFinite(o) && o > 0 ? Math.floor(o) : 0;
    }
  } catch {
    // Fall through to the safe default.
  }
  return 0;
}
