/**
 * v1.18.0 — module enable/disable gate resolver.
 *
 * Exercises the PURE resolver (`resolveModuleEnabled`) + the registry
 * helpers, so the disabled-allowlist + delegation logic is asserted
 * without a DB. The async `isModuleEnabled` / `requireModuleEnabled`
 * thin wrappers are covered by the route test.
 */
import { describe, it, expect } from "vitest";

import {
  resolveModuleEnabled,
  normalisePrefs,
  MODULE_DISABLED_ERROR_CODE,
  type ModuleGateInputs,
} from "../gate";
import {
  isCoreDomain,
  isModuleKey,
  moduleDelegatesTo,
  MODULE_KEYS,
  CORE_DOMAIN_KEYS,
} from "../registry";

function inputs(over: Partial<ModuleGateInputs> = {}): ModuleGateInputs {
  return {
    gender: null,
    disableCoach: false,
    modulePreferences: {},
    cycleTrackingEnabled: null,
    ...over,
  };
}

describe("resolveModuleEnabled — disabled allowlist (default-on)", () => {
  it("enables a module when no preference is recorded", () => {
    expect(resolveModuleEnabled("mood", inputs(), true)).toBe(true);
    expect(resolveModuleEnabled("sleep", inputs(), true)).toBe(true);
    expect(resolveModuleEnabled("labs", inputs(), true)).toBe(true);
  });

  it("enables a module when the key is present and true", () => {
    expect(
      resolveModuleEnabled("mood", inputs({ modulePreferences: { mood: true } }), true),
    ).toBe(true);
  });

  it("disables a module ONLY on an explicit false", () => {
    expect(
      resolveModuleEnabled(
        "glucose",
        inputs({ modulePreferences: { glucose: false } }),
        true,
      ),
    ).toBe(false);
  });

  it("isolates per-module: disabling one leaves siblings on", () => {
    const i = inputs({ modulePreferences: { workouts: false } });
    expect(resolveModuleEnabled("workouts", i, true)).toBe(false);
    expect(resolveModuleEnabled("recovery", i, true)).toBe(true);
    expect(resolveModuleEnabled("labs", i, true)).toBe(true);
  });
});

describe("resolveModuleEnabled — cycle delegation", () => {
  it("ignores the module blob and reads the cycle gate (gender-derived)", () => {
    // Even a crafted `{ cycle: false }` blob cannot override the real
    // FEMALE-derived enablement — the gate delegates to isCycleEnabled.
    const i = inputs({
      gender: "FEMALE",
      cycleTrackingEnabled: null,
      modulePreferences: { cycle: false },
    });
    expect(resolveModuleEnabled("cycle", i, true)).toBe(true);
  });

  it("respects the cycle toggle when set", () => {
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "MALE", cycleTrackingEnabled: true }),
        true,
      ),
    ).toBe(true);
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "FEMALE", cycleTrackingEnabled: false }),
        true,
      ),
    ).toBe(false);
  });

  it("a MALE account with a null toggle is cycle-disabled", () => {
    expect(
      resolveModuleEnabled("cycle", inputs({ gender: "MALE" }), true),
    ).toBe(false);
  });
});

describe("resolveModuleEnabled — coach delegation (two-layer)", () => {
  it("is enabled only when the operator master flag AND !disableCoach", () => {
    expect(
      resolveModuleEnabled("coach", inputs({ disableCoach: false }), true),
    ).toBe(true);
  });

  it("is disabled when the per-user opt-out is set", () => {
    expect(
      resolveModuleEnabled("coach", inputs({ disableCoach: true }), true),
    ).toBe(false);
  });

  it("is disabled when the operator master flag is off", () => {
    expect(
      resolveModuleEnabled("coach", inputs({ disableCoach: false }), false),
    ).toBe(false);
  });

  it("ignores the module blob for coach", () => {
    // A crafted `{ coach: true }` cannot re-enable against a disabled
    // operator flag or a user opt-out.
    const i = inputs({ disableCoach: true, modulePreferences: { coach: true } });
    expect(resolveModuleEnabled("coach", i, true)).toBe(false);
  });
});

describe("insights — narrative layer, not a delegated module", () => {
  it("resolves from the disabled allowlist like the other secondary domains", () => {
    expect(resolveModuleEnabled("insights", inputs(), true)).toBe(true);
    expect(
      resolveModuleEnabled(
        "insights",
        inputs({ modulePreferences: { insights: false } }),
        true,
      ),
    ).toBe(false);
  });

  it("is not delegated (no double source of truth marker)", () => {
    expect(moduleDelegatesTo("insights")).toBeUndefined();
  });
});

describe("normalisePrefs — fail-open coercion", () => {
  it("treats null / non-object / array as empty (all-on)", () => {
    expect(normalisePrefs(null)).toEqual({});
    expect(normalisePrefs(undefined)).toEqual({});
    expect(normalisePrefs("nope")).toEqual({});
    expect(normalisePrefs(["mood"])).toEqual({});
  });

  it("keeps only boolean values, dropping junk entries", () => {
    expect(
      normalisePrefs({ mood: false, sleep: "yes", glucose: 0, labs: true }),
    ).toEqual({ mood: false, labs: true });
  });
});

describe("registry — core domains can never be disabled", () => {
  it("the four core domains are not toggleable module keys", () => {
    for (const core of CORE_DOMAIN_KEYS) {
      expect(isModuleKey(core)).toBe(false);
      expect(isCoreDomain(core)).toBe(true);
    }
  });

  it("a crafted core-domain key is inert (never read as a module)", () => {
    // `weight: false` in the blob can't matter: weight is not a ModuleKey,
    // so the gate never consults it. The resolver only ever runs for the
    // 11 declared toggleable keys.
    expect(isModuleKey("weight")).toBe(false);
    expect(isModuleKey("medications")).toBe(false);
  });

  it("every toggleable key is a known module and not a core domain", () => {
    for (const key of MODULE_KEYS) {
      expect(isModuleKey(key)).toBe(true);
      expect(isCoreDomain(key)).toBe(false);
    }
  });
});

describe("wire contract", () => {
  it("exports the iOS-classifier errorCode", () => {
    expect(MODULE_DISABLED_ERROR_CODE).toBe("module.disabled");
  });
});
