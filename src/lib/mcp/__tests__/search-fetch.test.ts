/**
 * `search` + `fetch` — the ChatGPT default-mode retrieval pair.
 *
 * Pins the EXACT wire shapes OpenAI mandates (`{id,title,url}[]` /
 * `{id,title,text,url,metadata}`), real deep-link URLs, and the read-only
 * annotations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod/v4";

process.env.APP_URL = "https://health.example";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(),
}));
vi.mock("@/lib/ai/coach/tools/executor", () => ({ executeCoachTool: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: vi.fn(), findFirst: vi.fn() },
    labResult: { findMany: vi.fn() },
  },
}));

import { MCP_TOOLS } from "../tools";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { prisma } from "@/lib/db";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function tool(name: string) {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCoachDataInventory).mockResolvedValue({
    entries: [
      {
        tool: "get_metric_series",
        metric: "weight",
        domain: "weight",
        present: true,
        count: 10,
      },
    ],
    window: "90d",
    restMode: false,
    cycleEnabled: false,
  } as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([
    { id: "med-1", name: "Ramipril", dose: "5mg" },
  ] as never);
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([
    { analyte: "LDL" },
  ] as never);
});

describe("search", () => {
  it("returns { results: [{id,title,url}] } with real deep-link URLs", async () => {
    const def = tool("search");
    const result = (await def.run(CTX, { query: "" })) as {
      results: Array<{ id: string; title: string; url: string }>;
    };

    // Output conforms to the declared schema.
    const schema = z.object(def.outputShape!);
    expect(schema.safeParse(result).success).toBe(true);

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.id).toMatch(/^(metric|med|lab|domain):/);
      // ChatGPT only cites when `url` is a non-empty absolute URL.
      expect(r.url.startsWith("https://health.example/")).toBe(true);
    }
    // The internal id stays separate from the citation url.
    const med = result.results.find((r) => r.id === "med:med-1");
    expect(med?.url).toBe("https://health.example/medications");
  });

  it("filters by query (case-insensitive substring)", async () => {
    const def = tool("search");
    const result = (await def.run(CTX, { query: "ldl" })) as {
      results: Array<{ id: string }>;
    };
    expect(result.results.map((r) => r.id)).toContain("lab:LDL");
    expect(result.results.some((r) => r.id.startsWith("med:"))).toBe(false);
  });
});

describe("fetch", () => {
  it("returns { id,title,text,url,metadata } for a metric id", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { mean: 80 },
    } as never);
    const def = tool("fetch");
    const result = (await def.run(CTX, { id: "metric:weight" })) as Record<
      string,
      unknown
    >;
    const schema = z.object(def.outputShape!);
    expect(schema.safeParse(result).success).toBe(true);
    expect(result.id).toBe("metric:weight");
    expect(result.url).toBe("https://health.example/insights");
    expect(typeof result.text).toBe("string");
  });

  it("returns a not-found shape for an unknown id (still schema-valid)", async () => {
    const def = tool("fetch");
    const result = (await def.run(CTX, { id: "bogus" })) as Record<
      string,
      unknown
    >;
    const schema = z.object(def.outputShape!);
    expect(schema.safeParse(result).success).toBe(true);
    expect(result.title).toBe("Not found");
  });
});

describe("annotations", () => {
  it("search + fetch are read-only, non-destructive, closed-world", () => {
    for (const name of ["search", "fetch"]) {
      const a = tool(name).annotations;
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
      expect(a.openWorldHint).toBe(false);
    }
  });
});
