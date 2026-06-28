import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptNote,
  readNote,
  shapeMeasurementNotes,
  shapeMoodNote,
  shapeSideEffectNotes,
  shapeInventoryItemNotes,
  shapeDoseChangeNote,
} from "../note-cipher";

// A 32-byte key as 64 hex chars (the legacy single-key path).
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

beforeEach(() => {
  // Isolate from any ambient ENCRYPTION_KEYS map; drive the legacy single key.
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY_A);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptNote / readNote", () => {
  it("round-trips a note through encrypt -> decrypt", () => {
    const cipher = encryptNote("felt dizzy after the second dose");
    expect(cipher).toBeInstanceOf(Uint8Array);
    expect(readNote(cipher, null)).toBe("felt dizzy after the second dose");
  });

  it("preserves Unicode (umlauts / emoji) verbatim", () => {
    const cipher = encryptNote("Schwindel nach 2. Dosis 🤕 — Nürnberg");
    expect(readNote(cipher, null)).toBe(
      "Schwindel nach 2. Dosis 🤕 — Nürnberg",
    );
  });

  it("stores nothing for an absent / empty note", () => {
    expect(encryptNote(null)).toBeNull();
    expect(encryptNote(undefined)).toBeNull();
    expect(encryptNote("")).toBeNull();
  });

  it("falls back to the legacy plaintext column ONLY when there is no ciphertext", () => {
    // A not-yet-backfilled row: plaintext present, ciphertext null.
    expect(readNote(null, "legacy plaintext note")).toBe(
      "legacy plaintext note",
    );
    expect(readNote(new Uint8Array(0), "legacy plaintext note")).toBe(
      "legacy plaintext note",
    );
    expect(readNote(null, null)).toBeNull();
  });

  it("prefers the ciphertext over a stale plaintext value", () => {
    const cipher = encryptNote("the real note");
    // Even if a stale plaintext lingers, the ciphertext wins.
    expect(readNote(cipher, "stale plaintext")).toBe("the real note");
  });

  it("is fail-closed: a ciphertext that cannot be decrypted throws (never leaks the fallback)", () => {
    const cipher = encryptNote("secret note");
    // Rotate the key out from under the ciphertext: same key id, wrong bytes.
    vi.stubEnv("ENCRYPTION_KEY", KEY_B);
    expect(() =>
      readNote(cipher, "fallback that must NOT be returned"),
    ).toThrow();
  });
});

describe("shapeMeasurementNotes / shapeMoodNote", () => {
  it("decrypts onto `notes` and strips the ciphertext column", () => {
    const notesEncrypted = encryptNote("after lunch");
    const row = {
      id: "m1",
      value: 5.4,
      notes: null,
      notesEncrypted,
    };
    const shaped = shapeMeasurementNotes(row);
    expect(shaped.notes).toBe("after lunch");
    expect("notesEncrypted" in shaped).toBe(false);
    expect(shaped.id).toBe("m1");
    expect(shaped.value).toBe(5.4);
  });

  it("decrypts onto `note` and strips the ciphertext column", () => {
    const noteEncrypted = encryptNote("rough night");
    const row = { id: "x1", mood: "OKAY", note: null, noteEncrypted };
    const shaped = shapeMoodNote(row);
    expect(shaped.note).toBe("rough night");
    expect("noteEncrypted" in shaped).toBe(false);
    expect(shaped.mood).toBe("OKAY");
  });

  it("surfaces the legacy plaintext for a not-yet-backfilled measurement row", () => {
    const shaped = shapeMeasurementNotes({
      id: "m2",
      notes: "legacy plaintext",
      notesEncrypted: null,
    });
    expect(shaped.notes).toBe("legacy plaintext");
  });
});

describe("v1.25 medication note shapers", () => {
  it("shapeSideEffectNotes decrypts onto `notes` and strips the ciphertext", () => {
    const notesEncrypted = encryptNote("nausea on day 2");
    const row = {
      id: "se1",
      entry: "NAUSEA",
      severity: 3,
      notes: null,
      notesEncrypted,
    };
    const shaped = shapeSideEffectNotes(row);
    expect(shaped.notes).toBe("nausea on day 2");
    expect("notesEncrypted" in shaped).toBe(false);
    expect(shaped.entry).toBe("NAUSEA");
    expect(shaped.severity).toBe(3);
  });

  it("shapeInventoryItemNotes decrypts onto `notes` and strips the ciphertext", () => {
    const notesEncrypted = encryptNote("opened pen #2");
    const row = { id: "i1", state: "IN_USE", notes: null, notesEncrypted };
    const shaped = shapeInventoryItemNotes(row);
    expect(shaped.notes).toBe("opened pen #2");
    expect("notesEncrypted" in shaped).toBe(false);
    expect(shaped.state).toBe("IN_USE");
  });

  it("shapeDoseChangeNote decrypts onto `note` and strips the ciphertext", () => {
    const noteEncrypted = encryptNote("stepped up to 7.5 mg");
    const row = { id: "dc1", doseValue: 7.5, note: null, noteEncrypted };
    const shaped = shapeDoseChangeNote(row);
    expect(shaped.note).toBe("stepped up to 7.5 mg");
    expect("noteEncrypted" in shaped).toBe(false);
    expect(shaped.doseValue).toBe(7.5);
  });

  it("falls back to the legacy plaintext for not-yet-backfilled rows", () => {
    expect(
      shapeSideEffectNotes({ id: "se2", notes: "legacy", notesEncrypted: null })
        .notes,
    ).toBe("legacy");
    expect(
      shapeInventoryItemNotes({
        id: "i2",
        notes: "legacy",
        notesEncrypted: null,
      }).notes,
    ).toBe("legacy");
    expect(
      shapeDoseChangeNote({ id: "dc2", note: "legacy", noteEncrypted: null })
        .note,
    ).toBe("legacy");
  });

  it("is fail-closed: a side-effect ciphertext under a rotated key throws", () => {
    const notesEncrypted = encryptNote("secret note");
    vi.stubEnv("ENCRYPTION_KEY", KEY_B);
    expect(() =>
      shapeSideEffectNotes({ id: "se3", notes: null, notesEncrypted }),
    ).toThrow();
  });
});
