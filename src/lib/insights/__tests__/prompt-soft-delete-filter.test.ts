/**
 * v1.15.20 — soft-deleted rows must never reach an AI prompt snapshot.
 *
 * The user-facing DELETE flips `deletedAt` instead of removing the row,
 * so every prompt-feeding read has to filter the tombstones explicitly.
 * Three status generators (general / weight / bmi) and the Coach
 * snapshot's intake read shipped without the filter; this guard pins
 * the `deletedAt: null` predicate at each of those call sites so a
 * future query rewrite cannot silently drop it (same source-guard
 * pattern the queue-registration tests use).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, rel), "utf8");
}

describe("prompt reads exclude tombstoned rows", () => {
  it("general-status filters its measurement read", () => {
    const src = read("../general-status.ts");
    expect(src).toMatch(
      /measurement\s*\n?\s*\.findMany\(\{\s*where:\s*\{[\s\S]{0,300}?\bdeletedAt:\s*null/,
    );
  });

  it("weight-status filters its measurement read", () => {
    const src = read("../weight-status.ts");
    expect(src).toMatch(
      /measurement\s*\n?\s*\.findMany\(\{\s*where:\s*\{[\s\S]{0,300}?\bdeletedAt:\s*null/,
    );
  });

  it("bmi-status filters its measurement read", () => {
    const src = read("../bmi-status.ts");
    expect(src).toMatch(
      /measurement\s*\n?\s*\.findMany\(\{\s*where:\s*\{[\s\S]{0,300}?\bdeletedAt:\s*null/,
    );
  });

  it("the Coach snapshot filters its intake read", () => {
    const src = read("../../ai/coach/snapshot.ts");
    const intakeRead = src.match(
      /medicationIntakeEvent\.findMany\(\{[\s\S]{0,200}?where:\s*\{[^}]*\}/,
    );
    expect(intakeRead).not.toBeNull();
    expect(intakeRead![0]).toContain("deletedAt: null");
  });
});
