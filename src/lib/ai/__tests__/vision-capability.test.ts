import { describe, it, expect } from "vitest";

import {
  supportsVisionForConfig,
  supportsPdfForProvider,
} from "../vision-capability";

describe("supportsVisionForConfig", () => {
  it("accepts the Claude 3 / 3.5 / 3.7 / 4 families for anthropic", () => {
    for (const model of [
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307",
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

  it("reports vision for codex only on multimodal slugs", () => {
    for (const model of [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-4o",
      "gpt-4.1",
      "o1",
    ]) {
      expect(supportsVisionForConfig("codex", model)).toBe(true);
    }
    // Non-multimodal / unknown slugs and a missing slug → false.
    expect(supportsVisionForConfig("codex", "gpt-4")).toBe(false);
    expect(supportsVisionForConfig("codex", "gpt-3.5-turbo")).toBe(false);
    expect(supportsVisionForConfig("codex", null)).toBe(false);
    // The `-codex` specialist slugs are text-only despite the gpt-5 prefix.
    expect(supportsVisionForConfig("codex", "gpt-5-codex")).toBe(false);
    expect(supportsVisionForConfig("codex", "gpt-5.1-codex-mini")).toBe(false);
  });

  it("never reports vision for none", () => {
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
