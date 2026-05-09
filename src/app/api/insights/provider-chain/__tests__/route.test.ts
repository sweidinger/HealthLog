/**
 * v1.4.16 phase B5b — read-only chain summary surfaced under
 * `/settings/ai`. The full management UX is owned by B2 (provider
 * settings cleanup); this endpoint just lets the existing AI section
 * render "Active provider: codex" + "Configured: codex, openai" so the
 * user can see the cascade order without clicking into a dedicated
 * page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(),
}));

vi.mock("@/lib/ai/provider-runner", () => ({
  getLastWorkingProvider: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { GET } from "../route";
import { resolveProviderChain } from "@/lib/ai/provider";
import { getLastWorkingProvider } from "@/lib/ai/provider-runner";

interface Envelope {
  data?: {
    activeProvider: string | null;
    cachedActiveProvider: string | null;
    configuredChain: { providerType: string; available: boolean }[];
  };
  error?: string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/insights/provider-chain", () => {
  it("returns the resolved chain in priority order", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      {
        providerType: "codex",
        instance: { type: "codex" } as never,
      },
      {
        providerType: "admin-openai",
        instance: { type: "admin-key" } as never,
      },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data?.activeProvider).toBe("codex");
    expect(body.data?.configuredChain).toEqual([
      { providerType: "codex", available: true },
      { providerType: "admin-openai", available: true },
    ]);
  });

  it("surfaces the cached last-working provider when available", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      { providerType: "codex", instance: { type: "codex" } as never },
      {
        providerType: "openai",
        instance: { type: "admin-key" } as never,
      },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue("openai");

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.cachedActiveProvider).toBe("openai");
    // The chain still reports codex first (chain priority is the truth);
    // only the cache hint is updated. The UI reads both — primary line
    // is "Active provider: codex (cached: openai)".
    expect(body.data?.activeProvider).toBe("codex");
  });

  it("returns an empty chain + null active when nothing is configured", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.activeProvider).toBeNull();
    expect(body.data?.configuredChain).toEqual([]);
  });
});
