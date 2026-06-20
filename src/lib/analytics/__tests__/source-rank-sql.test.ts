/**
 * Unit pins for the source-rank SQL builders.
 *
 * `canonicalMeasurementsCte` (v1.18.11 perf#3a) was extracted so a statement
 * that references the canonical-source set more than once can bind it as a
 * single `WITH cm AS (…)` CTE and fold away the duplicate DISTINCT-ON
 * self-join. These tests pin:
 *   1. the alias-wrapped `canonicalMeasurementsFrom` is exactly the CTE body
 *      wrapped in `( … ) m` — so the single-reference call site is unchanged;
 *   2. the canonical body carries exactly ONE DISTINCT-ON pick — so a fold
 *      that references the CTE twice runs the expensive pick once;
 *   3. the interval whitelist still rejects an unsafe splice.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalMeasurementsCte,
  canonicalMeasurementsFrom,
} from "../source-rank-sql";

const RANK = "90";

describe("canonicalMeasurementsCte / canonicalMeasurementsFrom", () => {
  it("wraps the CTE body verbatim in the ( … ) m alias", () => {
    const cte = canonicalMeasurementsCte(RANK, "90 days");
    const from = canonicalMeasurementsFrom(RANK, "90 days");
    // The alias form is the CTE body plus the closing `) m` wrapper. Pinning
    // equality means the single-reference call sites keep byte-stable SQL
    // while the CTE body can be reused for the folded double-reference case.
    expect(from).toBe(`(${cte}\n      ) m`);
  });

  it("runs exactly one DISTINCT-ON canonical pick in the body", () => {
    const cte = canonicalMeasurementsCte(RANK, "90 days");
    const matches = cte.match(/DISTINCT ON/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("binds the user id as $1 and scopes both the inner and outer windows", () => {
    const cte = canonicalMeasurementsCte(RANK, "90 days");
    // user id is always a bound parameter, never spliced.
    expect(cte).toContain('"user_id" = $1');
    // The trailing-window bound appears on both the inner pick and the outer
    // filter so the folded references stay scoped identically.
    const intervalMatches = cte.match(/INTERVAL '90 days'/g) ?? [];
    expect(intervalMatches).toHaveLength(2);
  });

  it("omits the window clause entirely when no interval is given", () => {
    const cte = canonicalMeasurementsCte(RANK);
    expect(cte).not.toContain("INTERVAL");
  });

  it("rejects an unsafe interval splice", () => {
    expect(() => canonicalMeasurementsCte(RANK, "90 days; DROP TABLE")).toThrow(
      /unsafe interval/,
    );
  });
});
