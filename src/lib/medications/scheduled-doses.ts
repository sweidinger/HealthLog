/**
 * v1.32.9 (Coach Guard II / G3) — the numeric doses on a user's active
 * medication schedule, for the Grounding Ledger and the schedule-gated dose
 * continuation exemption.
 *
 * `Medication.dose` is free text as printed on the container ("7.5 mg",
 * "1 pieces", "0,25 mg"). It is deliberately NOT parsed into number + unit at
 * write time (see the schema note), so this helper extracts the leading numeric
 * magnitude the same way the display formatter does. The output is a de-duped
 * set of magnitudes: the guard asks "is 7.5 a dose this user is actually on?",
 * not "which medication", so the unit is irrelevant to the match.
 *
 * Server-only; a cheap indexed read over the user's active medications.
 */
import { prisma } from "@/lib/db";

/** Split on a leading number — mirrors `format-dose.ts` / `wizard-payload.ts`. */
const DOSE_EXPR_RE = /^\s*([+-]?\d+(?:[.,]\d+)?)/;

/** Parse the leading magnitude off a free-text dose, honouring a comma decimal. */
function parseDoseValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = DOSE_EXPR_RE.exec(raw.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * The de-duped set of numeric doses across the user's ACTIVE medications. Empty
 * when the user has no active medications or none carries a parseable dose.
 */
export async function getScheduledDoseValues(
  userId: string,
): Promise<number[]> {
  const rows = await prisma.medication.findMany({
    where: { userId, active: true },
    select: { dose: true },
  });
  const values = new Set<number>();
  for (const row of rows) {
    const value = parseDoseValue(row.dose);
    if (value !== null) values.add(value);
  }
  return [...values];
}
