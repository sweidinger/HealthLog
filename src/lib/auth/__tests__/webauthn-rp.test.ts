/**
 * Relying-party origin resolution.
 *
 * The localhost fallback used to sit in the candidate list unconditionally, so
 * a production deployment with a real `APP_URL` still accepted an assertion
 * whose `clientDataJSON.origin` was `http://localhost:3000`. The signed
 * `rpIdHash` pinned the real domain either way, so this never was a reachable
 * bypass — but a configured production origin has no reason to carry it, and an
 * unpinned second layer is exactly what regresses unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfiguredOrigins,
  getExpectedOrigin,
  getRpId,
} from "../webauthn-rp";

function setEnv(env: {
  nodeEnv?: string;
  appUrl?: string;
  publicAppUrl?: string;
}) {
  vi.unstubAllEnvs();
  if (env.nodeEnv !== undefined) vi.stubEnv("NODE_ENV", env.nodeEnv);
  vi.stubEnv("APP_URL", env.appUrl ?? "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.publicAppUrl ?? "");
}

beforeEach(() => {
  setEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getConfiguredOrigins", () => {
  it("drops the localhost fallback in production once an app URL is configured", () => {
    setEnv({ nodeEnv: "production", appUrl: "https://health.example" });
    const origins = getConfiguredOrigins();
    expect(origins).toEqual(["https://health.example"]);
    expect(origins).not.toContain("http://localhost:3000");
  });

  it("drops it in production when only the public build-time URL is set", () => {
    setEnv({ nodeEnv: "production", publicAppUrl: "https://health.example" });
    expect(getConfiguredOrigins()).not.toContain("http://localhost:3000");
  });

  it("keeps the localhost fallback outside production", () => {
    setEnv({ nodeEnv: "development", appUrl: "https://health.example" });
    expect(getConfiguredOrigins()).toContain("http://localhost:3000");
  });

  it("keeps it in production when nothing is configured, so getRpId still resolves", () => {
    setEnv({ nodeEnv: "production" });
    expect(getConfiguredOrigins()).toEqual(["http://localhost:3000"]);
    expect(getRpId()).toBe("localhost");
  });

  it("still pins the RP id to the configured domain in production", () => {
    setEnv({ nodeEnv: "production", appUrl: "https://health.example" });
    expect(getRpId()).toBe("health.example");
    expect(getExpectedOrigin()).toBe("https://health.example");
  });

  it("de-duplicates when both URL vars carry the same origin", () => {
    setEnv({
      nodeEnv: "production",
      appUrl: "https://health.example",
      publicAppUrl: "https://health.example/",
    });
    expect(getConfiguredOrigins()).toEqual(["https://health.example"]);
  });
});
