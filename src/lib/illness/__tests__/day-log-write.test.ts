/**
 * v1.18.1 — illness day-log upsert helper.
 *
 * Asserts the insert-vs-update split, the partial-merge contract (an
 * omitted field never nulls a stored value; an explicit null clears), and
 * the symptom-link reconciliation (resolve catalog keys, drop unknowns,
 * carry the 0–3 severity).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  illnessSymptom: { findMany: vi.fn() },
  illnessSymptomLink: { deleteMany: vi.fn(), createMany: vi.fn() },
  illnessDayLog: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(`enc:${s}`)),
  decryptFromBytes: (b: Uint8Array) =>
    Buffer.from(b).toString("utf8").replace(/^enc:/, ""),
}));

import {
  resolveIllnessSymptomIds,
  replaceIllnessSymptomLinks,
  upsertIllnessDayLog,
} from "@/lib/illness/day-log-write";
import type { IllnessDayLogInput } from "@/lib/validations/illness";

beforeEach(() => {
  vi.clearAllMocks();
  db.illnessDayLog.upsert.mockResolvedValue({ id: "dl-1" });
});

describe("resolveIllnessSymptomIds", () => {
  it("queries the active catalog and drops unknown keys", async () => {
    db.illnessSymptom.findMany.mockResolvedValue([
      { id: "is_cough", key: "cough" },
    ]);
    const out = await resolveIllnessSymptomIds(["cough", "not_a_symptom"]);
    expect(out).toEqual([{ key: "cough", id: "is_cough" }]);
    const where = db.illnessSymptom.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.key.in).toEqual(["cough", "not_a_symptom"]);
  });

  it("short-circuits on an empty key set", async () => {
    const out = await resolveIllnessSymptomIds([]);
    expect(out).toEqual([]);
    expect(db.illnessSymptom.findMany).not.toHaveBeenCalled();
  });
});

describe("replaceIllnessSymptomLinks", () => {
  it("clears then writes the links with their severity", async () => {
    db.illnessSymptom.findMany.mockResolvedValue([
      { id: "is_cough", key: "cough" },
      { id: "is_fatigue", key: "fatigue" },
    ]);
    await replaceIllnessSymptomLinks("dl-1", [
      { key: "cough", severity: 3 },
      { key: "fatigue" },
    ]);
    expect(db.illnessSymptomLink.deleteMany).toHaveBeenCalledWith({
      where: { dayLogId: "dl-1" },
    });
    expect(db.illnessSymptomLink.createMany).toHaveBeenCalledWith({
      data: [
        { dayLogId: "dl-1", symptomId: "is_cough", severity: 3 },
        { dayLogId: "dl-1", symptomId: "is_fatigue", severity: null },
      ],
      skipDuplicates: true,
    });
  });

  it("does not call createMany when nothing resolves", async () => {
    db.illnessSymptom.findMany.mockResolvedValue([]);
    await replaceIllnessSymptomLinks("dl-1", [{ key: "unknown" }]);
    expect(db.illnessSymptomLink.deleteMany).toHaveBeenCalled();
    expect(db.illnessSymptomLink.createMany).not.toHaveBeenCalled();
  });
});

describe("upsertIllnessDayLog", () => {
  const base: IllnessDayLogInput = {
    date: "2026-06-16",
    functionalImpact: 2,
    feverC: 38.4,
  };

  it("reports inserted (existed=false) on a fresh row", async () => {
    db.illnessDayLog.findUnique.mockResolvedValue(null);
    const result = await upsertIllnessDayLog("u1", "ep1", base, "Europe/Berlin");
    expect(result.existed).toBe(false);
    const args = db.illnessDayLog.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      episodeId_date: { episodeId: "ep1", date: "2026-06-16" },
    });
    expect(args.create.functionalImpact).toBe(2);
    expect(args.create.feverC).toBe(38.4);
  });

  it("reports updated (existed=true) on a re-post", async () => {
    db.illnessDayLog.findUnique.mockResolvedValue({
      id: "dl-1",
      functionalImpact: 1,
      feverC: null,
      noteEncrypted: null,
    });
    const result = await upsertIllnessDayLog("u1", "ep1", base, null);
    expect(result.existed).toBe(true);
  });

  it("partial-merges an omitted field (keeps the stored value)", async () => {
    db.illnessDayLog.findUnique.mockResolvedValue({
      id: "dl-1",
      functionalImpact: 3,
      feverC: 39,
      noteEncrypted: null,
    });
    // Only fever supplied — functionalImpact must keep the stored 3.
    await upsertIllnessDayLog("u1", "ep1", { date: "2026-06-16", feverC: 37 }, null);
    const args = db.illnessDayLog.upsert.mock.calls[0][0];
    expect(args.update.functionalImpact).toBe(3);
    expect(args.update.feverC).toBe(37);
  });

  it("clears a field on an explicit null", async () => {
    db.illnessDayLog.findUnique.mockResolvedValue({
      id: "dl-1",
      functionalImpact: 3,
      feverC: 39,
      noteEncrypted: null,
    });
    await upsertIllnessDayLog(
      "u1",
      "ep1",
      { date: "2026-06-16", feverC: null },
      null,
    );
    const args = db.illnessDayLog.upsert.mock.calls[0][0];
    expect(args.update.feverC).toBeNull();
  });

  it("encrypts a supplied note and skips link replace when symptoms omitted", async () => {
    db.illnessDayLog.findUnique.mockResolvedValue(null);
    await upsertIllnessDayLog(
      "u1",
      "ep1",
      { date: "2026-06-16", note: "rough night" },
      null,
    );
    const args = db.illnessDayLog.upsert.mock.calls[0][0];
    expect(args.create.noteEncrypted).toBeInstanceOf(Uint8Array);
    expect(db.illnessSymptomLink.deleteMany).not.toHaveBeenCalled();
  });
});
