import { describe, it, expect } from "vitest";
import {
  FEEDBACK_ATTRIBUTION_FALLBACK,
  pickProviderType,
} from "../feedback-attribution";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";

describe("pickProviderType", () => {
  it("prefers chainProviderType when present", () => {
    // chainProviderType captures the runner's chosen entry across the
    // multi-provider chain (B5b). When a fallback fires, the working
    // provider differs from the user's primary — the feedback row must
    // reflect the working provider, not the configured one.
    const got = pickProviderType({
      chainProviderType: "openai",
      providerType: "codex",
    });
    expect(got).toBe("openai");
  });

  it("falls back to providerType when chainProviderType is missing", () => {
    const got = pickProviderType({ providerType: "codex" });
    expect(got).toBe("codex");
  });

  it("falls back to 'unknown' when neither field is present", () => {
    const got = pickProviderType({});
    expect(got).toBe("unknown");
  });

  it("ignores non-string values", () => {
    const got = pickProviderType({
      chainProviderType: 123 as unknown as string,
      providerType: { name: "evil" } as unknown as string,
    });
    expect(got).toBe("unknown");
  });
});

describe("FEEDBACK_ATTRIBUTION_FALLBACK", () => {
  it("uses 'unknown' for the providerType so the aggregator groups separately", () => {
    expect(FEEDBACK_ATTRIBUTION_FALLBACK.providerType).toBe("unknown");
  });

  it("snapshots the current PROMPT_VERSION so the row is persistable", () => {
    expect(FEEDBACK_ATTRIBUTION_FALLBACK.promptVersion).toBe(PROMPT_VERSION);
  });
});
