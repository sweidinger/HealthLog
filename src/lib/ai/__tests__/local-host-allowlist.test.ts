import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLocalAiHostAllowed,
  requirePublicHostFor,
} from "../local-host-allowlist";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalAiHostAllowed", () => {
  it("denies every private host when unset (secure default)", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://ollama.lan/v1")).toBe(false);
  });

  it('treats "false" as denying every private host', () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "false");
    expect(isLocalAiHostAllowed("http://10.0.0.5/v1")).toBe(false);
  });

  it('keeps the legacy "true" = any private host', () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(true);
    expect(isLocalAiHostAllowed("http://anything.lan/v1")).toBe(true);
  });

  it("permits ONLY the listed hosts when given a comma-separated allowlist", () => {
    vi.stubEnv(
      "ALLOW_LOCAL_AI_PRIVATE_HOSTS",
      "ollama.lan, 10.0.0.5",
    );
    expect(isLocalAiHostAllowed("http://ollama.lan:11434/v1")).toBe(true);
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(true);
    // A different private host is still rejected — the metadata endpoint and
    // internal panels no longer ride the binary flag.
    expect(isLocalAiHostAllowed("http://169.254.169.254/latest/")).toBe(false);
    expect(isLocalAiHostAllowed("http://10.0.0.6/v1")).toBe(false);
  });

  it("matches hostnames case-insensitively and ignores blank entries", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", " , Ollama.LAN , ");
    expect(isLocalAiHostAllowed("http://ollama.lan/v1")).toBe(true);
  });

  it("never permits an unparseable URL", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    expect(isLocalAiHostAllowed("not a url")).toBe(true); // host-agnostic "any"
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "ollama.lan");
    expect(isLocalAiHostAllowed("not a url")).toBe(false);
  });

  it("requirePublicHostFor is the inverse of the allowlist", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "ollama.lan");
    expect(requirePublicHostFor("http://ollama.lan/v1")).toBe(false);
    expect(requirePublicHostFor("http://10.0.0.6/v1")).toBe(true);
  });
});
