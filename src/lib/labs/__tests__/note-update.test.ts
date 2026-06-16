/**
 * v1.18.1 — the lab-edit note-resolution guard.
 *
 * Core invariant: a failed decrypted-note load must NEVER send `note: null`
 * for a row that had a note — that would silently wipe it. The submit path
 * omits `note` (→ `undefined`) in that case so the server preserves it.
 */
import { describe, expect, it } from "vitest";

import { resolveNoteForUpdate } from "@/lib/labs/note-update";

describe("resolveNoteForUpdate", () => {
  it("omits note (undefined) when the load failed and the row had a note", () => {
    expect(
      resolveNoteForUpdate({
        noteLoadFailed: true,
        hadNote: true,
        editorValue: "",
      }),
    ).toBeUndefined();
  });

  it("clears (null) when the load failed but the row had no note", () => {
    // No note to preserve → an empty editor legitimately clears.
    expect(
      resolveNoteForUpdate({
        noteLoadFailed: true,
        hadNote: false,
        editorValue: "",
      }),
    ).toBeNull();
  });

  it("clears (null) when the editor is emptied on a successful load", () => {
    expect(
      resolveNoteForUpdate({
        noteLoadFailed: false,
        hadNote: true,
        editorValue: "   ",
      }),
    ).toBeNull();
  });

  it("sets the trimmed text when the editor has content", () => {
    expect(
      resolveNoteForUpdate({
        noteLoadFailed: false,
        hadNote: true,
        editorValue: "  fasting, morning  ",
      }),
    ).toBe("fasting, morning");
  });

  it("always preserves (undefined) when load failed on a row with a note, even with editor content", () => {
    // The edit sheet disables the note textarea in this state, so the editor
    // value is the stale-blank initial value. The guard must omit `note`
    // unconditionally here so a failed-to-decrypt note is never overwritten.
    expect(
      resolveNoteForUpdate({
        noteLoadFailed: true,
        hadNote: true,
        editorValue: "stale",
      }),
    ).toBeUndefined();
  });
});
