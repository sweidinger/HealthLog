import { describe, it, expect } from "vitest";

import {
  supportsVisionForConfig,
  supportsPdfForProvider,
} from "../vision-capability";

describe("supportsVisionForConfig", () => {
  it("accepts Claude 3.5+/4 family models for anthropic", () => {
    for (const model of [
      "claude-3-5-sonnet-latest",
      "claude-3-7-sonnet",
      "claude-sonnet-4-6",
      "claude-opus-4-1",
      "claude-haiku-4",
    ]) {
      expect(supportsVisionForConfig("anthropic", model)).toBe(true);
    }
  });

  it("rejects legacy / text-only anthropic models", () => {
    expect(supportsVisionForConfig("anthropic", "claude-2.1")).toBe(false);
    expect(supportsVisionForConfig("anthropic", "claude-instant-1")).toBe(
      false,
    );
    expect(supportsVisionForConfig("anthropic", null)).toBe(false);
  });

  it("accepts gpt-4o/4.1/turbo/o-series for openai + admin variants", () => {
    for (const providerType of [
      "openai",
      "admin-openai",
      "admin-key",
    ] as const) {
      expect(supportsVisionForConfig(providerType, "gpt-4o")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4o-mini")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4.1")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4-turbo")).toBe(true);
      expect(supportsVisionForConfig(providerType, "o1")).toBe(true);
    }
  });

  it("rejects non-vision openai models", () => {
    expect(supportsVisionForConfig("openai", "gpt-3.5-turbo")).toBe(false);
    expect(supportsVisionForConfig("openai", "gpt-4")).toBe(false);
    expect(supportsVisionForConfig("openai", null)).toBe(false);
  });

  it("trusts local (operator opted in) regardless of model string", () => {
    expect(supportsVisionForConfig("local", "llava")).toBe(true);
    expect(supportsVisionForConfig("local", null)).toBe(true);
  });

  it("never reports vision for codex or none", () => {
    expect(supportsVisionForConfig("codex", "gpt-4o")).toBe(false);
    expect(supportsVisionForConfig("none", "gpt-4o")).toBe(false);
  });
});

describe("supportsPdfForProvider", () => {
  it("only anthropic supports native PDF", () => {
    expect(supportsPdfForProvider("anthropic")).toBe(true);
    expect(supportsPdfForProvider("openai")).toBe(false);
    expect(supportsPdfForProvider("admin-openai")).toBe(false);
    expect(supportsPdfForProvider("local")).toBe(false);
    expect(supportsPdfForProvider("codex")).toBe(false);
  });
});
