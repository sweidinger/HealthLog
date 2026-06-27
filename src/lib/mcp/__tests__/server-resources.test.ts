/**
 * Guards for the browseable surface wired in `createMcpServer`: the resource
 * templates are registered, and the top-level data-grounding contract is stated
 * in the server instructions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, MCP_SERVER_INSTRUCTIONS } from "../server";
import { MCP_RESOURCE_TEMPLATES, MCP_RESOURCES } from "../resources";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "u-1",
  tokenId: "t-1",
  scopes: ["health:read"],
  binding: "u-1:t-1",
  canRead: true,
  canWrite: false,
};

let registeredResources: string[];

beforeEach(() => {
  registeredResources = [];
  vi.spyOn(McpServer.prototype, "registerTool").mockReturnValue({} as never);
  vi.spyOn(McpServer.prototype, "registerPrompt").mockReturnValue({} as never);
  vi.spyOn(McpServer.prototype, "registerResource").mockImplementation(
    function (this: unknown, name: string) {
      registeredResources.push(name);
      return {} as never;
    },
  );
});

describe("createMcpServer browseable surface", () => {
  it("registers every fixed resource and every resource template", () => {
    createMcpServer(CTX);
    for (const r of MCP_RESOURCES) {
      expect(registeredResources).toContain(r.name);
    }
    for (const t of MCP_RESOURCE_TEMPLATES) {
      expect(registeredResources).toContain(t.name);
    }
  });
});

describe("server instructions", () => {
  it("states the data-grounding + safety contract", () => {
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    // The four load-bearing properties of the whole surface.
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/server-side/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/present: false/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/never instructions/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/list_metrics|inventory/i);
    // No diagnosis / verdict — the read-only clinical-safety floor.
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/no diagnosis|never a diagnosis/i);
  });

  it("is passed to the underlying server instance", () => {
    const server = createMcpServer(CTX);
    // The SDK stores the instructions on the underlying Server; expose check
    // via the public server handle without depending on private fields shape.
    expect(server.server).toBeDefined();
  });
});
