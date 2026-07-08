import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Document-class provider order (governance fix, oauth-investigation
 * SYNTHESIS §1). Pins: for a DOCUMENT read the chain is reprioritised
 * local-first with codex (ChatGPT-subscription OAuth) LAST, and the egress
 * class the vault notice reads is vendor-blind local/external. Coach / insights
 * do not use these helpers, so their app-wide order is untouched.
 */

vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveVisionProvider: vi.fn(),
  resolveTextProvider: vi.fn(),
}));

import {
  documentEgressClass,
  reorderChainForDocumentClass,
  resolveDocumentVisionProvider,
} from "../provider-order";
import {
  resolveVisionProvider,
  type VisionProviderPick,
} from "@/lib/labs/ocr-capability";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

function entry(providerType: string): ProviderChainResolved {
  return {
    providerType: providerType as ProviderChainResolved["providerType"],
    instance: {
      type: providerType,
      generateCompletion: vi.fn(),
    } as unknown as ProviderChainResolved["instance"],
  };
}

const order = (chain: ProviderChainResolved[]) =>
  reorderChainForDocumentClass(chain).map((e) => e.providerType);

describe("reorderChainForDocumentClass", () => {
  it("demotes codex last and lifts local first for the default chain", () => {
    // The persisted default chain the audit flagged: codex at priority 1.
    const chain = [
      entry("codex"),
      entry("openai"),
      entry("anthropic"),
      entry("local"),
      entry("admin-openai"),
    ];
    expect(order(chain)).toEqual([
      "local",
      "openai",
      "anthropic",
      "admin-openai",
      "codex",
    ]);
  });

  it("keeps codex behind local even when codex is the only cheap option", () => {
    expect(order([entry("codex"), entry("local")])).toEqual(["local", "codex"]);
  });

  it("is stable within a rank tier (preserves user order for BYOK keys)", () => {
    expect(order([entry("anthropic"), entry("openai")])).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(order([entry("openai"), entry("anthropic")])).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("does not mutate the input array", () => {
    const chain = [entry("codex"), entry("local")];
    reorderChainForDocumentClass(chain);
    expect(chain.map((e) => e.providerType)).toEqual(["codex", "local"]);
  });
});

describe("documentEgressClass", () => {
  it("classifies local as on-machine and everything else as external", () => {
    expect(documentEgressClass("local")).toBe("local");
    expect(documentEgressClass("codex")).toBe("external");
    expect(documentEgressClass("openai")).toBe("external");
    expect(documentEgressClass("anthropic")).toBe("external");
    expect(documentEgressClass("admin-openai")).toBe("external");
  });
});

describe("resolveDocumentVisionProvider", () => {
  beforeEach(() => vi.mocked(resolveVisionProvider).mockReset());

  it("invokes the shared resolver with the document reorder that demotes codex", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      localOcrEnabled: false,
      pick: null,
    } as VisionProviderPick);

    await resolveDocumentVisionProvider("u1");

    const call = vi.mocked(resolveVisionProvider).mock.calls[0]!;
    expect(call[0]).toBe("u1");
    const reorder = call[1]!.reorder!;
    // The reorder the document resolver hands down puts a codex-first chain
    // local-first — proving documents never default to the subscription path.
    expect(
      reorder([entry("codex"), entry("local")]).map((e) => e.providerType),
    ).toEqual(["local", "codex"]);
  });
});
