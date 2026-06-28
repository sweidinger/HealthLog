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
    // v1.24 — operational reads (schedule / integration status / preventive care).
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    medicationIntakeEvent: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => []),
    },
    medicationScheduleRevision: { groupBy: vi.fn(async () => []) },
    integrationStatus: { findMany: vi.fn(async () => []) },
    measurementReminder: { findMany: vi.fn(async () => []) },
  },
}));
// v1.24 — the operational reads delegate to existing server-authoritative
// engines; stub them so the registry-wide loops never reach a real engine.
vi.mock("@/lib/medications/scheduling/next-due", () => ({
  computeDisplayDue: vi.fn(() => null),
  OVERDUE_LOOKBACK_MS: 1000,
  toResolvedSlotMark: vi.fn((e) => ({
    at: e.scheduledFor,
    slotAnchored: true,
  })),
}));
vi.mock("@/lib/integrations/status", () => ({
  getIntegrationStatus: vi.fn(),
}));
vi.mock("@/lib/measurement-reminders/dto", () => ({
  toMeasurementReminderDto: vi.fn((r) => r),
}));
// Phase 4 — the deep-value reads delegate to the rich-reads engines; stub them
// so the registry-wide loops (surface / annotation / no-verdict) never reach a
// real engine. Their own logic is covered in `rich-reads.test.ts`.
vi.mock("../rich-reads", () => ({
  getCorrelation: vi.fn(async () => ({ present: true })),
  compareMetric: vi.fn(async () => ({ present: true })),
  getMetricBaseline: vi.fn(async () => ({ present: true })),
  detectChangepoints: vi.fn(async () => ({ present: true })),
  getLabHistory: vi.fn(async () => ({ present: true })),
  LAB_HISTORY_MAX_LIMIT: 50,
}));

import { MCP_TOOLS, MCP_TOOL_NAMES } from "../tools";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import { prisma } from "@/lib/db";
import { computeDisplayDue } from "@/lib/medications/scheduling/next-due";
import { getIntegrationStatus } from "@/lib/integrations/status";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
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
  it("registers exactly the read tools", () => {
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
        // Phase 4 — deep-value reads.
        "get_correlation",
        "compare_metric",
        "get_metric_baseline",
        "detect_changepoints",
        // v1.24 — Coach-F1 reads bridged to the wire.
        "get_glucose_panel",
        "get_sleep",
        "get_workouts",
        "get_illness_recovery",
        "get_cycle",
        // v1.24 — multi-metric fan-out.
        "get_metrics",
        // v1.24 — operational reads.
        "get_medication_schedule",
        "get_integration_status",
        "get_preventive_care",
      ].sort(),
    );
  });

  it("every read tool declares a structured outputSchema", () => {
    for (const def of MCP_TOOLS) {
      expect(def.outputShape, `${def.name} lacks outputShape`).toBeDefined();
    }
  });

  it("advertised inventory tools all exist on the wire (no advertise-but-missing drift)", () => {
    // The `list_metrics` inventory advertises a fixed set of tool names; every
    // one must be a registered read tool or the wire is self-inconsistent.
    const advertised = [
      "get_metric_series",
      "get_glucose_panel",
      "get_sleep",
      "get_medication_compliance",
      "get_workouts",
      "get_labs",
      "get_illness_recovery",
      "get_correlations",
      "get_cycle",
    ];
    for (const name of advertised) {
      expect(MCP_TOOL_NAMES).toContain(name);
    }
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

describe("get_metrics — multi-metric fan-out + pagination", () => {
  it("fans out over get_metric_series and returns one result per metric", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { metric: "x", section: { aggregate: { mean: 1 } } },
    });
    const result = (await tool("get_metrics").run(CTX, {
      metrics: ["weight", "pulse", "hrv"],
      window: "last30days",
    })) as {
      present: boolean;
      results: Array<{ metric: string; present: boolean }>;
      nextCursor?: string;
    };
    expect(result.present).toBe(true);
    expect(result.results.map((r) => r.metric)).toEqual([
      "weight",
      "pulse",
      "hrv",
    ]);
    // The window threads through to the single-metric read.
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "get_metric_series",
        rawArguments: JSON.stringify({
          metric: "weight",
          window: "last30days",
        }),
      }),
    );
    expect(result.nextCursor).toBeUndefined();
  });

  it("paginates with an opaque cursor that round-trips", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({ present: true, data: {} });
    const metrics = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const page1 = (await tool("get_metrics").run(CTX, { metrics })) as {
      results: Array<{ metric: string }>;
      nextCursor?: string;
    };
    // First page is bounded (METRICS_PAGE_SIZE = 8) and offers a cursor.
    expect(page1.results).toHaveLength(8);
    expect(typeof page1.nextCursor).toBe("string");

    const page2 = (await tool("get_metrics").run(CTX, {
      metrics,
      cursor: page1.nextCursor,
    })) as { results: Array<{ metric: string }>; nextCursor?: string };
    expect(page2.results).toHaveLength(2);
    expect(page2.results[0].metric).toBe("m8");
    expect(page2.nextCursor).toBeUndefined();
  });

  it("caps the metrics array at the per-call maximum", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({ present: true, data: {} });
    const metrics = Array.from({ length: 40 }, (_, i) => `m${i}`);
    // Page through and count distinct metrics actually fetched.
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = (await tool("get_metrics").run(CTX, {
        metrics,
        ...(cursor ? { cursor } : {}),
      })) as { results: Array<{ metric: string }>; nextCursor?: string };
      for (const r of page.results) seen.add(r.metric);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(24); // MAX_METRICS_PER_CALL
  });
});

describe("get_medication_schedule", () => {
  it("returns per-medication next-due + overdue, scoped to the session user", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "m-1",
        name: "Ramipril",
        dose: "5 mg",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        asNeeded: false,
        schedules: [],
      },
    ] as never);
    vi.mocked(computeDisplayDue).mockReturnValue({
      at: new Date("2026-06-28T08:00:00Z"),
      overdue: true,
    });

    const result = (await tool("get_medication_schedule").run(CTX, {})) as {
      present: boolean;
      medications: Array<{
        name: string;
        nextDueAt: string | null;
        overdue: boolean;
        asNeeded: boolean;
      }>;
    };

    expect(prisma.medication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", active: true } }),
    );
    expect(result.present).toBe(true);
    expect(result.medications).toHaveLength(1);
    expect(result.medications[0]).toMatchObject({
      name: "Ramipril",
      overdue: true,
      asNeeded: false,
    });
    expect(result.medications[0].nextDueAt).toBe("2026-06-28T08:00:00.000Z");
  });

  it("returns { present: false } when no medications are tracked", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    const result = (await tool("get_medication_schedule").run(CTX, {})) as {
      present: boolean;
    };
    expect(result.present).toBe(false);
  });
});

describe("get_integration_status", () => {
  it("reports per-provider sync health and carries no secrets", async () => {
    vi.mocked(prisma.integrationStatus.findMany).mockResolvedValue([
      { integration: "withings" },
    ] as never);
    vi.mocked(getIntegrationStatus).mockResolvedValue({
      integration: "withings",
      state: "error_reauth",
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      lastAttemptAt: "2026-06-27T00:00:00.000Z",
      lastError: "token revoked",
      consecutiveFailuresByKind: null,
    });

    const result = (await tool("get_integration_status").run(CTX, {})) as {
      present: boolean;
      providers: Array<Record<string, unknown>>;
    };
    expect(result.present).toBe(true);
    expect(result.providers).toHaveLength(1);
    const p = result.providers[0];
    expect(p).toMatchObject({
      provider: "withings",
      state: "error_reauth",
      connected: true,
      reauthRequired: true,
    });
    // No secret / token / raw-error fields leak to the assistant.
    expect(p).not.toHaveProperty("lastError");
    expect(JSON.stringify(p)).not.toContain("token revoked");
  });

  it("returns { present: false } when nothing has ever synced", async () => {
    vi.mocked(prisma.integrationStatus.findMany).mockResolvedValue([] as never);
    const result = (await tool("get_integration_status").run(CTX, {})) as {
      present: boolean;
    };
    expect(result.present).toBe(false);
  });
});

describe("get_preventive_care", () => {
  it("surfaces the configured reminder due-list with overdue flags", async () => {
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValue([
      { id: "r-1" },
    ] as never);
    vi.mocked(toMeasurementReminderDto).mockReturnValue({
      id: "r-1",
      label: "Blood pressure check",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: 30,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      notifyHour: 9,
      location: null,
      nextDueAt: "2000-01-01T00:00:00.000Z",
      lastSatisfiedAt: null,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = (await tool("get_preventive_care").run(CTX, {})) as {
      present: boolean;
      checkups: Array<Record<string, unknown>>;
    };
    expect(prisma.measurementReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null, enabled: true },
      }),
    );
    expect(result.present).toBe(true);
    expect(result.checkups[0]).toMatchObject({
      label: "Blood pressure check",
      measurementType: "BLOOD_PRESSURE_SYS",
      overdue: true, // a year-2000 due date is in the past
    });
  });

  it("returns { present: false } when no reminders are configured", async () => {
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValue(
      [] as never,
    );
    const result = (await tool("get_preventive_care").run(CTX, {})) as {
      present: boolean;
    };
    expect(result.present).toBe(false);
  });
});

describe("search — cursor pagination", () => {
  it("returns a bounded page and an opaque nextCursor when more results exist", async () => {
    // 60 lab analytes → exceeds the 50-result page.
    vi.mocked(buildCoachDataInventory).mockResolvedValue({
      entries: [],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { sources: [] },
    } as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ analyte: `A${i}` })) as never,
    );

    const page1 = (await tool("search").run(CTX, { query: "" })) as {
      results: unknown[];
      nextCursor?: string;
    };
    expect(page1.results).toHaveLength(50);
    expect(typeof page1.nextCursor).toBe("string");

    const page2 = (await tool("search").run(CTX, {
      query: "",
      cursor: page1.nextCursor,
    })) as { results: unknown[]; nextCursor?: string };
    expect(page2.results).toHaveLength(10);
    expect(page2.nextCursor).toBeUndefined();
  });
});
