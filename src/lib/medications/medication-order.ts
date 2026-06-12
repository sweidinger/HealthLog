/**
 * v1.16.10 — the user-defined manual medication order, applied to BOTH
 * /medications views (cards and table).
 *
 * The persisted layout carries an ordered list of medication ids
 * (`MedicationListLayout.order`). Medications named there render first,
 * in that order; every other medication (newly created since the last
 * save, or never ordered) appends after the ordered block in the
 * alphabetical default the list always used. Ids that no longer resolve
 * to a medication are simply ignored — a deleted medication must not
 * corrupt the order.
 */

/** The default tiebreak the list used before manual ordering existed. */
export function compareMedicationNames(
  a: { name: string },
  b: { name: string },
): number {
  return a.name.localeCompare(b.name, "de", { sensitivity: "base" });
}

export function applyMedicationOrder<T extends { id: string; name: string }>(
  medications: readonly T[],
  order: readonly string[],
): T[] {
  const position = new Map<string, number>();
  order.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const ordered = medications
    .filter((m) => position.has(m.id))
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const rest = medications
    .filter((m) => !position.has(m.id))
    .sort(compareMedicationNames);
  return [...ordered, ...rest];
}
