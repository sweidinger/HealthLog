import { describe, it, expect } from "vitest";

import {
  tokenAllowsWrite,
  SCOPE_HEALTH_READ,
  SCOPE_HEALTH_WRITE,
  SCOPE_WILDCARD,
} from "../scopes";

describe("tokenAllowsWrite", () => {
  it("is false for a read-only token", () => {
    expect(tokenAllowsWrite([SCOPE_HEALTH_READ])).toBe(false);
  });
  it("is true for a read+write token", () => {
    expect(tokenAllowsWrite([SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE])).toBe(
      true,
    );
  });
  it("is true for the wildcard token", () => {
    expect(tokenAllowsWrite([SCOPE_WILDCARD])).toBe(true);
  });
  it("is false for an empty scope set", () => {
    expect(tokenAllowsWrite([])).toBe(false);
  });
});
