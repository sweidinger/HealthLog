import { describe, it, expect, vi, beforeEach } from "vitest";

const logMcpMeasurement = vi.fn();
const logMcpMood = vi.fn();
vi.mock("../writes", () => ({
  logMcpMeasurement: (...a: unknown[]) => logMcpMeasurement(...a),
  logMcpMood: (...a: unknown[]) => logMcpMood(...a),
}));

const checkMcpWriteRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkMcpWriteRateLimit: (...a: unknown[]) => checkMcpWriteRateLimit(...a),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { MCP_WRITE_TOOLS, MCP_WRITE_TOOL_NAMES } from "../write-tools";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "u-1",
  tokenId: "t-1",
  scopes: ["health:read", "health:write"],
  binding: "u-1:t-1",
  canRead: true,
  canWrite: true,
};

function tool(name: string) {
  const t = MCP_WRITE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkMcpWriteRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 1000,
  });
});

describe("write-tool surface", () => {
  it("exposes exactly log_measurement and log_mood", () => {
    expect([...MCP_WRITE_TOOL_NAMES].sort()).toEqual([
      "log_measurement",
      "log_mood",
    ]);
  });

  it("annotates writes as non-read-only, non-destructive, idempotent", () => {
    for (const t of MCP_WRITE_TOOLS) {
      expect(t.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});

describe("confirm gate — log_measurement", () => {
  it("confirm:false returns a preview and writes NOTHING", async () => {
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;

    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(result.preview).toMatchObject({
      type: "WEIGHT",
      value: 80,
      source: "MCP",
    });
    expect(logMcpMeasurement).not.toHaveBeenCalled();
    expect(checkMcpWriteRateLimit).not.toHaveBeenCalled();
  });

  it("confirm:true executes the core and reports the written record", async () => {
    logMcpMeasurement.mockResolvedValue({
      status: "written",
      measurement: {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;

    expect(logMcpMeasurement).toHaveBeenCalledTimes(1);
    expect(logMcpMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        type: "WEIGHT",
        value: 80,
        idempotencyKey: "k-1",
      }),
    );
    expect(result.written).toBe(true);
  });

  it("an idempotent replay reports alreadyLogged, not a duplicate write", async () => {
    logMcpMeasurement.mockResolvedValue({
      status: "already_logged",
      measurement: {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.alreadyLogged).toBe(true);
  });

  it("refuses to commit when the write budget is exhausted", async () => {
    checkMcpWriteRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 1000,
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.error).toBe("rate_limited");
    expect(logMcpMeasurement).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric value before any write", async () => {
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: Number.NaN,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(logMcpMeasurement).not.toHaveBeenCalled();
  });
});

describe("confirm gate — log_mood", () => {
  it("confirm:false returns a preview and writes NOTHING", async () => {
    const result = (await tool("log_mood").run(CTX, {
      score: 4,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(logMcpMood).not.toHaveBeenCalled();
  });

  it("confirm:true commits the mood entry", async () => {
    logMcpMood.mockResolvedValue({
      status: "written",
      moodEntry: {
        score: 4,
        mood: "GUT",
        note: null,
        date: "2026-06-27",
        source: "MCP",
      },
    });
    const result = (await tool("log_mood").run(CTX, {
      score: 4,
      confirm: true,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(logMcpMood).toHaveBeenCalledTimes(1);
    expect(result.written).toBe(true);
  });

  it("rejects an out-of-band score before any write", async () => {
    const result = (await tool("log_mood").run(CTX, {
      score: 9,
      confirm: true,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(logMcpMood).not.toHaveBeenCalled();
  });
});
