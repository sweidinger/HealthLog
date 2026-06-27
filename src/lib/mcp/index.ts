/**
 * HealthLog MCP server — barrel.
 *
 * A read-only-by-default Model Context Protocol surface that re-exports
 * HealthLog's existing server-authoritative read paths over the MCP wire, so a
 * user can query their own health data from any MCP-capable assistant. The tool
 * / resource layer here is transport-agnostic; transports (stdio now, remote
 * `/mcp` later) attach to `createMcpServer(ctx)`.
 */
export { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server";
export { resolveMcpAuthContext, type McpAuthContext } from "./auth";
export { MCP_TOOLS, MCP_TOOL_NAMES, type McpToolDefinition } from "./tools";
export {
  MCP_RESOURCES,
  MCP_RESOURCE_URIS,
  type McpResourceDefinition,
} from "./resources";
export {
  MCP_PROMPTS,
  MCP_PROMPT_NAMES,
  type McpPromptDefinition,
  type McpPromptResult,
  type McpPromptMessage,
} from "./prompts";
export {
  getCorrelation,
  compareMetric,
  getMetricBaseline,
  detectChangepoints,
  resolveRichMetric,
  type RichMetric,
} from "./rich-reads";
export {
  SCOPE_HEALTH_READ,
  SCOPE_HEALTH_WRITE,
  SCOPE_WILDCARD,
  tokenAllowsRead,
  tokenAllowsWrite,
  sessionBinding,
} from "./scopes";
