/**
 * Registry invariants — the drift guard that pins the SIGNAL REGISTRY to the
 * values the per-surface tables carry today. Any edit that changes a derived
 * table (FHIR coding, correlation eligibility, metric-status metadata) without
 * intentionally updating the golden master fails here, so a registry flip stays
 * a byte-for-byte no-op and accidental cross-surface drift cannot land.
 *
 * Golden masters under `./fixtures/*` were extracted verbatim from the
 * hand-maintained tables at the v1.25 branch base; update them deliberately
 * (and in lock-step with the registry) when a value genuinely changes.
 */
import { describe, expect, it } from "vitest";

import {
  METRIC_STATUS_IDS,
  getMetricStatusMeta,
} from "@/lib/insights/metric-status-registry";
import { MEASUREMENT_LOINC } from "@/lib/fhir/loinc-map";
import {
  SIGNALS,
  allSignals,
  getSignal,
  signalForMeasurementType,
} from "@/lib/signals/registry";
import { deriveMetricStatusRegistry } from "@/lib/signals/adapters/metric-status";
import { deriveMeasurementLoinc } from "@/lib/signals/adapters/fhir";
import { deriveBucketedTypes } from "@/lib/signals/adapters/correlation";

import expectedMeasurementLoinc from "./fixtures/expected-measurement-loinc.json";
import expectedBucketedTypes from "./fixtures/expected-bucketed-types.json";

describe("signal registry — structural sanity", () => {
  it("every entry's key matches its record key", () => {
    for (const [key, signal] of Object.entries(SIGNALS)) {
      expect(signal.key).toBe(key);
    }
  });

  it("every signal carries a well-formed source for its kind", () => {
    for (const signal of allSignals()) {
      if (signal.kind === "biomarker") {
        expect(signal.source.biomarkerKey.length).toBeGreaterThan(0);
      } else {
        expect(signal.source.measurementType.length).toBeGreaterThan(0);
      }
    }
  });

  it("mcp exposure follows Coach-snapshot inclusion", () => {
    // The MCP get_metric_series enum is the Coach scope vocabulary, so a signal
    // is MCP-readable iff it carries a Coach scope (and vice-versa).
    for (const signal of allSignals()) {
      const hasScope = signal.surfaces.coachSnapshot !== false;
      expect(signal.surfaces.mcp).toBe(hasScope);
    }
  });

  it("signalForMeasurementType round-trips every measurement/score signal", () => {
    for (const signal of allSignals()) {
      if (signal.kind === "biomarker") continue;
      expect(signalForMeasurementType(signal.source.measurementType)).toBe(
        signal,
      );
    }
  });
});

describe("signal registry — metric-status projection equals the live table", () => {
  it("registers every generic metric-status id", () => {
    for (const id of METRIC_STATUS_IDS) {
      expect(getSignal(id)).not.toBeNull();
    }
  });

  it("derives each MetricStatusMeta byte-for-byte from the registry", () => {
    const derived = deriveMetricStatusRegistry();
    for (const id of METRIC_STATUS_IDS) {
      expect(derived[id]).toEqual(getMetricStatusMeta(id));
    }
  });
});

describe("signal registry — FHIR table is byte-identical", () => {
  it("derives MEASUREMENT_LOINC equal to the golden master", () => {
    expect(deriveMeasurementLoinc()).toEqual(expectedMeasurementLoinc);
  });

  it("the live (flipped) MEASUREMENT_LOINC export equals the golden master", () => {
    expect(MEASUREMENT_LOINC).toEqual(expectedMeasurementLoinc);
  });
});

describe("signal registry — correlation table is byte-identical", () => {
  it("derives BUCKETED_TYPES equal to the golden master (set semantics)", () => {
    expect([...deriveBucketedTypes()].sort()).toEqual(
      [...(expectedBucketedTypes as string[])].sort(),
    );
  });
});
