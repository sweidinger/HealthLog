import { describe, expect, it } from "vitest";
import {
  parseProviderChain,
  serializeProviderChain,
  PROVIDER_CHAIN_DEFAULT,
  type ProviderChainEntry,
} from "../provider-chain";

describe("parseProviderChain", () => {
  it("returns the default when input is null", () => {
    expect(parseProviderChain(null)).toEqual(PROVIDER_CHAIN_DEFAULT);
  });

  it("returns the default when input is undefined", () => {
    expect(parseProviderChain(undefined)).toEqual(PROVIDER_CHAIN_DEFAULT);
  });

  it("returns the default when input is malformed (not an array)", () => {
    expect(parseProviderChain({ junk: true })).toEqual(PROVIDER_CHAIN_DEFAULT);
  });

  it("returns the default when input is an empty array", () => {
    expect(parseProviderChain([])).toEqual(PROVIDER_CHAIN_DEFAULT);
  });

  it("strips invalid entries and keeps valid ones", () => {
    const input = [
      { providerType: "codex", priority: 1, enabled: true },
      { providerType: "fictional", priority: 2, enabled: true },
      { providerType: "openai", priority: 3, enabled: true },
    ];
    const out = parseProviderChain(input);
    expect(out.map((e) => e.providerType)).toEqual(["codex", "openai"]);
  });

  it("recognises admin-codex as a valid type but excludes it from the default", () => {
    // The operator-shared central Codex is a known chain type (so an appended
    // entry typechecks), but it is opt-in only and never part of the default.
    expect(PROVIDER_CHAIN_DEFAULT.map((e) => e.providerType)).not.toContain(
      "admin-codex",
    );
    const out = parseProviderChain([
      { providerType: "admin-codex", priority: 1, enabled: true },
    ]);
    expect(out.map((e) => e.providerType)).toEqual(["admin-codex"]);
  });

  it("sorts by priority ascending (lowest priority value first)", () => {
    const input: ProviderChainEntry[] = [
      { providerType: "openai", priority: 5, enabled: true },
      { providerType: "codex", priority: 1, enabled: true },
      { providerType: "anthropic", priority: 3, enabled: true },
    ];
    const out = parseProviderChain(input);
    expect(out.map((e) => e.providerType)).toEqual([
      "codex",
      "anthropic",
      "openai",
    ]);
  });

  it("preserves insertion order for ties in priority", () => {
    const input: ProviderChainEntry[] = [
      { providerType: "openai", priority: 1, enabled: true },
      { providerType: "anthropic", priority: 1, enabled: true },
    ];
    const out = parseProviderChain(input);
    expect(out.map((e) => e.providerType)).toEqual(["openai", "anthropic"]);
  });

  it("deduplicates by providerType (first occurrence wins)", () => {
    const input: ProviderChainEntry[] = [
      { providerType: "codex", priority: 1, enabled: true },
      { providerType: "codex", priority: 5, enabled: false },
    ];
    const out = parseProviderChain(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      providerType: "codex",
      priority: 1,
      enabled: true,
    });
  });

  it("coerces missing enabled flag to true", () => {
    const input = [{ providerType: "codex", priority: 1 }];
    const out = parseProviderChain(input);
    expect(out[0].enabled).toBe(true);
  });
});

describe("serializeProviderChain", () => {
  it("round-trips through parse without mutation", () => {
    const chain: ProviderChainEntry[] = [
      { providerType: "codex", priority: 1, enabled: true },
      { providerType: "openai", priority: 2, enabled: false },
    ];
    const json = serializeProviderChain(chain);
    expect(parseProviderChain(JSON.parse(json))).toEqual(chain);
  });

  it("produces a parseable JSON string", () => {
    const chain: ProviderChainEntry[] = [
      { providerType: "codex", priority: 1, enabled: true },
    ];
    expect(() => JSON.parse(serializeProviderChain(chain))).not.toThrow();
  });
});

describe("PROVIDER_CHAIN_DEFAULT", () => {
  it("starts with codex (the cheapest path for ChatGPT-Pro users)", () => {
    expect(PROVIDER_CHAIN_DEFAULT[0].providerType).toBe("codex");
  });

  it("includes admin OpenAI as final fallback so misconfigured users still see insights", () => {
    const last = PROVIDER_CHAIN_DEFAULT[PROVIDER_CHAIN_DEFAULT.length - 1];
    expect(last.providerType).toBe("admin-openai");
  });

  it("priorities are strictly ascending", () => {
    const priorities = PROVIDER_CHAIN_DEFAULT.map((e) => e.priority);
    for (let i = 1; i < priorities.length; i += 1) {
      expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
    }
  });

  it("every entry is enabled by default", () => {
    expect(PROVIDER_CHAIN_DEFAULT.every((e) => e.enabled)).toBe(true);
  });
});
