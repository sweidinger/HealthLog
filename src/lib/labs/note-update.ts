/**
 * v1.18.1 — note-resolution for the lab-reading edit PUT.
 *
 * The edit sheet loads a row's decrypted note from the single-resource GET.
 * If that load FAILS we must never send `note: null` — an empty editor would
 * then wipe a note we simply couldn't read. This pure helper encodes the
 * three-way decision the submit path uses:
 *
 *  - load failed AND the row had a note  → `undefined` (omit `note` from the
 *    PUT body so the server preserves the stored ciphertext untouched).
 *  - editor is empty                     → `null` (clear the note).
 *  - editor has text                     → the trimmed text (set the note).
 *
 * `undefined` is the signal the caller uses to OMIT the key entirely.
 */
export function resolveNoteForUpdate(args: {
  noteLoadFailed: boolean;
  hadNote: boolean;
  editorValue: string;
}): string | null | undefined {
  if (args.noteLoadFailed && args.hadNote) return undefined;
  const trimmed = args.editorValue.trim();
  return trimmed ? trimmed : null;
}
