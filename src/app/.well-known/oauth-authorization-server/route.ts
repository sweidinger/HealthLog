/**
 * RFC 8414 — OAuth Authorization Server Metadata for the built-in bridge AS.
 *
 * Public, unauthenticated discovery (added to the proxy `.well-known` allowlist).
 * Advertises the authorize / token / register endpoints, `S256`-only PKCE, and
 * CIMD support (`client_id_metadata_document_supported: true` + `none` auth) so
 * Claude.ai / ChatGPT can self-register and complete the OAuth 2.1 + PKCE flow.
 */
import { authorizationServerMetadata } from "@/lib/mcp/oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return Response.json(authorizationServerMetadata(request.url), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
