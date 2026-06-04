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

/** Narrow a thrown Prisma error to the P2002 unique-constraint code. */
export function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}
