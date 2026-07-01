/**
 * Shared Prisma error narrowing helpers.
 *
 * The P2002 (unique-constraint violation) predicate was hand-copied into
 * five call sites (rollup persist, intake-slot dedup, slot upsert, legacy
 * step consolidation, dense-intraday retention). v1.11.2 folds them into
 * this single helper so a future change to the P2002 semantics has one
 * place to live instead of five.
 *
 * Deliberately structural (`typeof === "object"` + `"code" in err` +
 * `code === "P2002"`) rather than `instanceof Prisma.PrismaClientKnownRequestError`
 * so it survives client-bundling quirks while staying specific to the
 * unique-constraint code.
 */

/** Narrow a thrown Prisma error to a specific known-request code. */
function hasPrismaCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/** Narrow a thrown Prisma error to the P2002 unique-constraint code. */
export function isP2002(err: unknown): boolean {
  return hasPrismaCode(err, "P2002");
}

/**
 * Narrow a thrown Prisma error to the P2025 "record not found" code — the
 * error `delete` / `update` raise when the target row no longer exists. Lets
 * an idempotent delete treat "already gone" as success while still surfacing a
 * genuine failure (a real DB fault raises a different code and rethrows).
 */
export function isP2025(err: unknown): boolean {
  return hasPrismaCode(err, "P2025");
}
