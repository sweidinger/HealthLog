/**
 * Local stdio entrypoint for the HealthLog MCP server.
 *
 * A power-user runs this in a plain Node process and points an MCP client
 * (Claude Desktop, etc.) at it. Authentication is a pasted, scoped `hlk_<hex>`
 * Bearer token — no OAuth infrastructure (REQ-T1). The token is read from the
 * `HEALTHLOG_MCP_TOKEN` environment variable (preferred — keeps the secret out
 * of the process argument list) or, as a fallback, the first CLI argument.
 *
 * Off by default: with no token the server refuses to start. Running it with a
 * minted token IS the opt-in.
 *
 * Run it with tsx (the standalone production image strips tsx, so this is a
 * local-only tool):
 *
 *   HEALTHLOG_MCP_TOKEN=hlk_... \
 *   API_TOKEN_HMAC_KEY=... DATABASE_URL=... ENCRYPTION_KEYS=... \
 *   pnpm dlx tsx src/cli/mcp-stdio.ts
 *
 * stdout is the JSON-RPC channel — every diagnostic goes to stderr so it can
 * never corrupt the protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "@/lib/mcp/server";
import { resolveMcpAuthContext } from "@/lib/mcp/auth";

function readToken(): string | null {
  const fromEnv = process.env.HEALTHLOG_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;
  return null;
}

async function main(): Promise<void> {
  const token = readToken();
  if (!token) {
    console.error(
      "HealthLog MCP: no token. Set HEALTHLOG_MCP_TOKEN (a scoped hlk_ Bearer token) or pass it as the first argument.",
    );
    process.exit(1);
  }

  let ctx;
  try {
    ctx = await resolveMcpAuthContext(token);
  } catch {
    // Do not echo the token or the underlying reason to stderr.
    console.error("HealthLog MCP: token rejected.");
    process.exit(1);
  }

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `HealthLog MCP server running on stdio (session ${ctx.binding}).`,
  );
}

main().catch((error) => {
  console.error("HealthLog MCP: fatal error during startup.", error);
  process.exit(1);
});
