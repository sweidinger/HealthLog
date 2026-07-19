/**
 * Guard: the confirmed write tools are advertised ONLY to a write-scoped
 * session. A read-only (`health:read`) session must see zero write tools — the
 * read-only-by-default posture is structural, not a runtime flag.
 *
 * Registration gating alone is not enough to pin the property. It asserts what
 * the server ADVERTISES, so a refactor that registered the write tools
 * unconditionally and intended to refuse at call time would keep these tests
 * green while opening the write surface. The second block therefore drives the
 * run bodies directly with a read-only context and asserts the write cores are
 * never reached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

const writeCores = vi.hoisted(() => ({
  logMcpMeasurement: vi.fn(),
  logMcpMood: vi.fn(),
  logMcpBloodPressure: vi.fn(),
  checkMcpMeasurement: vi.fn(() => ({ ok: true })),
  checkMcpBloodPressure: vi.fn(() => ({ ok: true })),
}));
vi.mock("../writes", () => writeCores);
vi.mock("@/lib/rate-limit", () => ({
  checkMcpWriteRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server";
import { MCP_WRITE_TOOLS, MCP_WRITE_TOOL_NAMES } from "../write-tools";
import type { McpAuthContext } from "../auth";

function ctx(canWrite: boolean): McpAuthContext {
  return {
    userId: "u-1",
    tokenId: "t-1",
    scopes: canWrite ? ["health:read", "health:write"] : ["health:read"],
    binding: "u-1:t-1",
    canRead: true,
    canWrite,
  };
}

let registered: string[];

beforeEach(() => {
  registered = [];
  vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
    this: unknown,
    name: string,
  ) {
    registered.push(name);
    return {} as never;
  });
  // Prompts / resources registration is irrelevant here — stub to no-ops.
  vi.spyOn(McpServer.prototype, "registerPrompt").mockReturnValue({} as never);
  vi.spyOn(McpServer.prototype, "registerResource").mockReturnValue(
    {} as never,
  );
});

describe("write-tool registration gating", () => {
  it("a read-only session sees NO write tools", () => {
    createMcpServer(ctx(false));
    for (const name of MCP_WRITE_TOOL_NAMES) {
      expect(registered).not.toContain(name);
    }
    // It still registers read tools.
    expect(registered).toContain("list_metrics");
  });

  it("a write-scoped session sees the write tools", () => {
    createMcpServer(ctx(true));
    for (const name of MCP_WRITE_TOOL_NAMES) {
      expect(registered).toContain(name);
    }
    expect(registered).toContain("log_measurement");
    expect(registered).toContain("log_mood");
  });
});

/**
 * The behavioural half. These call the run bodies the way the SDK would,
 * bypassing registration entirely — exactly the shape a "register everything,
 * refuse at call time" refactor would take.
 */
describe("write-tool scope enforcement in the call path", () => {
  /** Committing args for each tool — `confirm:true`, so nothing else gates. */
  const commitArgs: Record<string, Record<string, unknown>> = {
    log_measurement: {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    },
    log_mood: { score: 4, confirm: true, idempotencyKey: "k-2" },
    log_blood_pressure: {
      systolic: 120,
      diastolic: 80,
      confirm: true,
      idempotencyKey: "k-3",
    },
  };

  it("every write tool refuses a read-only context without touching a write core", async () => {
    for (const tool of MCP_WRITE_TOOLS) {
      const result = (await tool.run(
        ctx(false),
        commitArgs[tool.name],
      )) as Record<string, unknown>;

      expect(result.written).toBe(false);
      expect(result.error).toBe("insufficient_scope");
    }

    // Not one write core was reached, for any tool.
    expect(writeCores.logMcpMeasurement).not.toHaveBeenCalled();
    expect(writeCores.logMcpMood).not.toHaveBeenCalled();
    expect(writeCores.logMcpBloodPressure).not.toHaveBeenCalled();
  });

  it("the same committing args DO write under a write-scoped context", async () => {
    // The negative test above is only meaningful if these args would otherwise
    // commit — otherwise it could pass for the wrong reason.
    writeCores.logMcpMood.mockResolvedValue({
      status: "created",
      moodEntry: { id: "m-1" },
    });

    const moodTool = MCP_WRITE_TOOLS.find((t) => t.name === "log_mood")!;
    const result = (await moodTool.run(
      ctx(true),
      commitArgs.log_mood,
    )) as Record<string, unknown>;

    expect(writeCores.logMcpMood).toHaveBeenCalledTimes(1);
    expect(result.written).toBe(true);
  });

  it("guards every tool in the registry, so a new write tool cannot skip it", async () => {
    // Pins the wrapper as the enforcement point rather than three hand-written
    // checks that a fourth tool could forget.
    expect(MCP_WRITE_TOOLS.length).toBeGreaterThan(0);
    const refusals = await Promise.all(
      MCP_WRITE_TOOLS.map(async (tool) => {
        const r = (await tool.run(ctx(false), {})) as Record<string, unknown>;
        return r.error;
      }),
    );
    expect(refusals.every((e) => e === "insufficient_scope")).toBe(true);
  });
});
