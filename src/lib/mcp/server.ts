/**
 * MCP server factory.
 *
 * Composes an `McpServer` from the official SDK and registers the read tools +
 * resources from the transport-agnostic registries, bound to one resolved
 * session context. This factory is intentionally transport-free: the stdio
 * adapter (this phase) and the future remote `/mcp` adapter both call
 * `createMcpServer(ctx)` and then attach their own transport, so the tool /
 * resource surface is identical across wires (ADR-002).
 *
 * Only read tools are registered (REQ-SEC-1 / ADR-003). There is no admin
 * surface here and none can be added structurally — `requireAdmin()` is
 * cookie-only and the MCP context carries no cookie (REQ-SEC-7 / ADR-005).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpAuthContext } from "./auth";
import { MCP_TOOLS } from "./tools";
import { MCP_RESOURCES } from "./resources";

export const MCP_SERVER_NAME = "healthlog";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Build an MCP server for one authenticated session. The returned server is not
 * yet connected to a transport — the caller attaches stdio (or, later, the
 * Streamable-HTTP transport).
 */
export function createMcpServer(ctx: McpAuthContext): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        // Annotations are MANDATORY for the cloud connectors — the ChatGPT
        // Apps SDK treats an omitted hint as a validation error. Every read
        // tool is read-only, non-destructive, closed-world (ADR-003).
        annotations: tool.annotations,
        ...(tool.outputShape ? { outputSchema: tool.outputShape } : {}),
      },
      async (args: Record<string, unknown>) => {
        const result = await tool.run(ctx, args ?? {});
        const content = [
          { type: "text" as const, text: JSON.stringify(result) },
        ];
        // When the tool declares an outputSchema (search / fetch), also return
        // the object as `structuredContent` so ChatGPT + the model can read the
        // typed shape; the JSON-in-`content` keeps backwards compatibility.
        if (tool.outputShape) {
          return {
            content,
            structuredContent: result as Record<string, unknown>,
          };
        }
        return { content };
      },
    );
  }

  for (const resource of MCP_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri: URL) => {
        const data = await resource.read(ctx);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: resource.mimeType,
              text: JSON.stringify(data),
            },
          ],
        };
      },
    );
  }

  return server;
}
