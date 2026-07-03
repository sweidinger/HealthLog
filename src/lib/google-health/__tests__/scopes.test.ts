import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOOGLE_HEALTH_CORE_SCOPES,
  GOOGLE_HEALTH_EXPERIMENTAL_SCOPES,
  experimentalScopesEnabled,
  getGoogleHealthScopeString,
  resolveGoogleHealthScopes,
} from "../client";

describe("Google Health scope resolver", () => {
  const KEY = "GOOGLE_HEALTH_EXPERIMENTAL_SCOPES";
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it("ships exactly the four core Restricted read scopes by default", () => {
    delete process.env[KEY];
    const scopes = resolveGoogleHealthScopes();
    expect(scopes).toEqual([...GOOGLE_HEALTH_CORE_SCOPES]);
    expect(scopes).toHaveLength(4);
    // Every core scope is a Restricted read-only googlehealth scope.
    for (const s of scopes) {
      expect(s).toMatch(
        /^https:\/\/www\.googleapis\.com\/auth\/googlehealth\..+\.readonly$/,
      );
    }
  });

  it("keeps the ECG/IRN experimental scopes off unless opted in", () => {
    delete process.env[KEY];
    expect(experimentalScopesEnabled()).toBe(false);
    const scopes = resolveGoogleHealthScopes();
    for (const ex of GOOGLE_HEALTH_EXPERIMENTAL_SCOPES) {
      expect(scopes).not.toContain(ex);
    }
  });

  it('adds ECG + IRN when the flag is "true" or "1"', () => {
    for (const flag of ["true", "1"]) {
      process.env[KEY] = flag;
      expect(experimentalScopesEnabled()).toBe(true);
      const scopes = resolveGoogleHealthScopes();
      expect(scopes).toEqual([
        ...GOOGLE_HEALTH_CORE_SCOPES,
        ...GOOGLE_HEALTH_EXPERIMENTAL_SCOPES,
      ]);
      expect(scopes).toHaveLength(6);
    }
  });

  it("treats any other flag value as off", () => {
    for (const flag of ["", "false", "yes", "0"]) {
      process.env[KEY] = flag;
      expect(experimentalScopesEnabled()).toBe(false);
    }
  });

  it("joins the resolved scopes with a single space for the authorize request", () => {
    delete process.env[KEY];
    expect(getGoogleHealthScopeString()).toBe(
      GOOGLE_HEALTH_CORE_SCOPES.join(" "),
    );
    expect(getGoogleHealthScopeString().split(" ")).toHaveLength(4);
  });
});
