import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks hoisted before importing the module under test. ---
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: vi.fn(),
}));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));
// v1.22.0 — `search` reads the record directly via Prisma; stub it so the
// registry-wide loops never reach a DB.
vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    labResult: { findMany: vi.fn(async () => []) },
  },
}));

import { MCP_TOOLS, MCP_TOOL_NAMES } from "../tools";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
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
  vi.resetAllMocks();
});

describe("MCP tool registry — surface", () => {
  it("registers exactly the Phase-1 read tools", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "get_correlations",
        "get_labs",
        "get_medication_compliance",
        "get_metric_series",
        "list_metrics",
        // v1.22.0 — the ChatGPT default-mode retrieval pair.
        "search",
        "fetch",
      ].sort(),
    );
  });

  it("annotates every tool read-only / closed-world (cloud-connector requirement)", () => {
    for (const def of MCP_TOOLS) {
      expect(def.annotations.readOnlyHint).toBe(true);
      expect(def.annotations.destructiveHint).toBe(false);
      expect(def.annotations.openWorldHint).toBe(false);
    }
  });

  it("exposes no admin / write tool", () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/admin/i);
      expect(name).not.toMatch(
        /^(log_|create_|update_|delete_|export_|write_)/,
      );
    }
  });
});

describe("list_metrics", () => {
  it("enumerates available metrics with coverage from the inventory", async () => {
    vi.mocked(buildCoachDataInventory).mockResolvedValue({
      entries: [
        {
          tool: "get_metric_series",
          metric: "bp",
          domain: "blood pressure",
          present: true,
          count: 42,
        },
        {
          tool: "get_metric_series",
          metric: "weight",
          domain: "weight",
          present: false,
        },
      ],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { sources: [], window: "last30days" },
    } as never);

    const result = (await tool("list_metrics").run(CTX, {})) as {
      present: boolean;
      window: string;
      metrics: unknown[];
    };

    expect(buildCoachDataInventory).toHaveBeenCalledWith("user-1", undefined);
    expect(result.present).toBe(true);
    expect(result.window).toBe("last30days");
    expect(result.metrics).toHaveLength(2);
  });
});

describe("get_metric_series", () => {
  it("forwards validated args + session userId to the F1 executor and returns the grounded result", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { metric: "bp", section: { unit: "mmHg" } },
      grounding: "Population band 120/80 mmHg.",
    });

    const result = (await tool("get_metric_series").run(CTX, {
      metric: "bp",
      window: "last90days",
    })) as { present: boolean; grounding?: string };

    expect(executeCoachTool).toHaveBeenCalledWith({
      userId: "user-1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp", window: "last90days" }),
    });
    expect(result.present).toBe(true);
    // Units / reference bands ride the result (ADR-004).
    expect(result.grounding).toContain("mmHg");
  });

  it("returns { present: false } for an absent metric (never a silent zero)", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: false,
      reason: "no_data",
    });
    const result = (await tool("get_metric_series").run(CTX, {
      metric: "weight",
    })) as { present: boolean; reason?: string };
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
  });
});

describe("get_medication_compliance", () => {
  it("forwards to the F1 executor under its name", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { compliance: { short: { rate: 90 } } },
    });
    const result = (await tool("get_medication_compliance").run(CTX, {})) as {
      present: boolean;
    };
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        name: "get_medication_compliance",
      }),
    );
    expect(result.present).toBe(true);
  });
});

describe("get_labs", () => {
  it("forwards the optional analyte filter and returns readings with units + bands", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: {
        recent: [
          {
            analyte: "LDL",
            value: 120,
            unit: "mg/dL",
            referenceHigh: 116,
            rangeStatus: "above",
          },
        ],
      },
    });
    const result = (await tool("get_labs").run(CTX, { analyte: "LDL" })) as {
      present: boolean;
    };
    expect(executeCoachTool).toHaveBeenCalledWith({
      userId: "user-1",
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: "LDL" }),
    });
    expect(result.present).toBe(true);
  });
});

describe("get_correlations", () => {
  it("forwards to the F1 executor and returns FDR-controlled drivers", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { drivers: [], pairsTested: 20, windowDays: 180 },
    });
    const result = (await tool("get_correlations").run(CTX, {})) as {
      present: boolean;
    };
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", name: "get_correlations" }),
    );
    expect(result.present).toBe(true);
  });
});

describe("no prose verdict (ADR-004 / REQ-SEC-2)", () => {
  it("every tool result is a structured object without verdict/diagnosis fields", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({ present: true, data: {} });
    vi.mocked(buildCoachDataInventory).mockResolvedValue({
      entries: [],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { sources: [] },
    } as never);

    for (const def of MCP_TOOLS) {
      const args = def.name === "get_metric_series" ? { metric: "bp" } : {};
      const result = await def.run(CTX, args);
      expect(typeof result).toBe("object");
      const keys = Object.keys(result as object);
      expect(keys).not.toContain("verdict");
      expect(keys).not.toContain("diagnosis");
      expect(keys).not.toContain("advice");
    }
  });
});
