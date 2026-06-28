/**
 * Guard: the confirmed write tools are advertised ONLY to a write-scoped
 * session. A read-only (`health:read`) session must see zero write tools — the
 * read-only-by-default posture is structural, not a runtime flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server";
import { MCP_WRITE_TOOL_NAMES } from "../write-tools";
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
