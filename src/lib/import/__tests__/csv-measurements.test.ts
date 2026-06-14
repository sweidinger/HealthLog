import { describe, it, expect } from "vitest";

import {
  parseCsvMeasurements,
  splitCsvRows,
} from "@/lib/import/csv-measurements";

// Pin the clock so the entry-instant bound is deterministic. All fixture
// timestamps sit comfortably in the past relative to this.
const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

function parse(rows: string[]) {
  return parseCsvMeasurements([HEADER, ...rows].join("\n"), { now: NOW });
}

describe("splitCsvRows", () => {
  it("handles CRLF, quoted commas, escaped quotes, and a BOM", () => {
    const csv =
      "﻿a,b,c\r\n1,\"x,y\",\"he said \"\"hi\"\"\"\r\n2,plain,z\r\n";
    const grid = splitCsvRows(csv);
    expect(grid).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", 'he said "hi"'],
      ["2", "plain", "z"],
    ]);
  });

  it("drops trailing blank lines", () => {
    expect(splitCsvRows("a,b\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsvMeasurements — header validation", () => {
  it("is fatal when a required column is missing", () => {
    const out = parseCsvMeasurements("type,value,unit\nWEIGHT,80,kg", {
      now: NOW,
    });
    expect(out.fatal?.reason).toBe("missing_required_column");
    expect(out.rows).toEqual([]);
  });

  it("is fatal on an empty file", () => {
    const out = parseCsvMeasurements("", { now: NOW });
    expect(out.fatal?.reason).toBe("missing_required_column");
  });

  it("accepts columns in any order", () => {
    const out = parseCsvMeasurements(
      ["unit,measuredAt,type,value", "kg,2026-05-01T08:00:00Z,WEIGHT,80.5"].join(
        "\n",
      ),
      { now: NOW },
    );
    expect(out.fatal).toBeUndefined();
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.value).toBe(80.5);
  });
});

describe("parseCsvMeasurements — per-row partial failure", () => {
  it("imports the good rows and skips the bad ones with distinct reasons", () => {
    const out = parse([
      "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,", // ok
      "NOPE,1,kg,2026-05-01T08:00:00Z,,,", // unknown_type
      "WEIGHT,9999,kg,2026-05-01T08:00:00Z,,,", // value_out_of_range
      "WEIGHT,80,kg,2026-05-01T08:00:00,,,", // missing_timezone_offset
    ]);
    const byLine = Object.fromEntries(
      out.rows.map((r) => [r.line, { status: r.status, reason: r.reason }]),
    );
    expect(byLine[2]).toEqual({ status: "ok", reason: undefined });
    expect(byLine[3]).toEqual({ status: "skipped", reason: "unknown_type" });
    expect(byLine[4]).toEqual({
      status: "skipped",
      reason: "value_out_of_range",
    });
    expect(byLine[5]).toEqual({
      status: "skipped",
      reason: "missing_timezone_offset",
    });
  });

  it("reports line numbers 1-based with the header as line 1", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].line).toBe(2);
  });
});

describe("parseCsvMeasurements — unit conversion", () => {
  it("converts glucose mmol/L to canonical mg/dL", () => {
    const out = parse([
      "BLOOD_GLUCOSE,5.3,mmol/L,2026-05-01T08:00:00Z,FASTING,,",
    ]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("mg/dL");
    expect(out.rows[0].row?.value).toBeCloseTo(5.3 * 18.016, 3);
  });

  it("converts weight lb to canonical kg", () => {
    const out = parse(["WEIGHT,180,lb,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("kg");
    expect(out.rows[0].row?.value).toBeCloseTo(180 * 0.453592, 3);
  });

  it("accepts the canonical unit case-insensitively", () => {
    const out = parse(["WEIGHT,80,KG,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.unit).toBe("kg");
  });

  it("skips an unrecognised unit rather than mis-storing", () => {
    const out = parse(["WEIGHT,80,stone,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "unknown_unit",
    });
  });
});

describe("parseCsvMeasurements — timezone + entry-instant bound", () => {
  it("skips a timestamp without an offset (no silent local interpretation)", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00,,,"]);
    expect(out.rows[0].reason).toBe("missing_timezone_offset");
  });

  it("accepts both Z and ±HH:MM offsets", () => {
    const out = parse([
      "WEIGHT,80,kg,2026-05-01T08:00:00Z,,,",
      "WEIGHT,81,kg,2026-05-01T08:00:00+02:00,,,",
    ]);
    expect(out.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("rejects a future-dated row via the entry-instant bound", () => {
    // 10 minutes past NOW — beyond the 5-min skew tolerance.
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    const out = parse([`WEIGHT,80,kg,${future},,,`]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("rejects a pre-1900 row", () => {
    const out = parse(["WEIGHT,80,kg,1899-12-31T00:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });
});

describe("parseCsvMeasurements — glucose context", () => {
  it("requires a context for BLOOD_GLUCOSE", () => {
    const out = parse(["BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "missing_glucose_context",
    });
  });

  it("rejects a context on a non-glucose row", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,FASTING,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "unexpected_glucose_context",
    });
  });

  it("rejects an unknown context value", () => {
    const out = parse(["BLOOD_GLUCOSE,95,mg/dL,2026-05-01T08:00:00Z,LUNCH,,"]);
    expect(out.rows[0]).toMatchObject({
      status: "skipped",
      reason: "invalid_glucose_context",
    });
  });
});

describe("parseCsvMeasurements — optional columns", () => {
  it("carries externalId through and trims notes", () => {
    const out = parse(["WEIGHT,80,kg,2026-05-01T08:00:00Z,, after run ,ext-9"]);
    expect(out.rows[0].row).toMatchObject({
      externalId: "ext-9",
      notes: "after run",
    });
  });

  it("works without the optional columns present at all", () => {
    const out = parseCsvMeasurements(
      ["type,value,unit,measuredAt", "WEIGHT,80,kg,2026-05-01T08:00:00Z"].join(
        "\n",
      ),
      { now: NOW },
    );
    expect(out.rows[0].status).toBe("ok");
    expect(out.rows[0].row?.externalId).toBeUndefined();
  });
});
