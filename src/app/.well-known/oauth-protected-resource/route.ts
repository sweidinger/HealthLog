/**
 * RFC 9728 — OAuth Protected Resource Metadata for the `/mcp` resource.
 *
 * Public, unauthenticated discovery (added to the proxy `.well-known` allowlist).
 * A remote MCP client reads this after the `/mcp` 401 to learn which
 * Authorization Server backs the resource and what scopes it accepts. The
 * `resource` value is the canonical `/mcp` URI and MUST match the URL the user
 * pasted into Claude.ai / ChatGPT.
 */
import { protectedResourceMetadata } from "@/lib/mcp/oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return Response.json(protectedResourceMetadata(request.url), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
