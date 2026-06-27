/**
 * Remote MCP endpoint — Streamable HTTP transport.
 *
 * Exposes the SAME read-only tool / resource layer the stdio transport
 * serves (`src/lib/mcp/`) over HTTP, so a remote MCP client (Claude.ai /
 * ChatGPT / the hosted-or-iOS crowd) can connect with a manually-minted
 * `hlk_<hex>` Bearer token before full OAuth lands (ADR-002 / ADR-006). The
 * wire protocol — JSON-RPC framing, capability negotiation, the
 * GET/POST/DELETE method matrix — is the official SDK's
 * `WebStandardStreamableHTTPServerTransport`; this route only owns the four
 * HealthLog-specific gates in front of it:
 *
 *   1. AUTH — `Authorization: Bearer hlk_…` resolved by the SAME validator
 *      the HTTP edge uses (`resolveMcpAuthContext` → `resolveBearerToken`),
 *      so revoked / expired / scope semantics never drift between the stdio,
 *      remote, and REST wires. A cookie is never consulted — the wire
 *      carries none — so the cookie-only `requireAdmin()` boundary is
 *      unreachable here by construction (ADR-005 / REQ-SEC-7). No token,
 *      a malformed header, or a rejected token all answer one blunt 401.
 *
 *   2. RATE LIMIT — the Postgres limiter keyed by the `<userId>:<tokenId>`
 *      binding (`mcp:<binding>`), so a single leaked / shared credential
 *      cannot drain the account's other tokens (REQ-SEC-9 / REQ-SEC-11).
 *
 *   3. MODULE GATE — the `mcp` module is OPT-IN (off by default). With the
 *      module off the surface answers 404 and reveals nothing — a
 *      self-hoster who never opts in gets zero new exposure (ADR-007 /
 *      REQ-OPS-1).
 *
 *   4. TRANSPORT — a fresh stateless server + transport per request
 *      (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), torn
 *      down once the buffered JSON-RPC response is built.
 *
 * Read-only: the factory registers read tools only and `requireAdmin()` is
 * cookie-only, so neither writes nor admin can be reached over this wire
 * regardless of token scope — including `["*"]` (ADR-003 / ADR-005). The
 * `health:write` scope stays reserved and unreachable until the write
 * tools land in a later phase.
 *
 * Same-origin / no-CORS by construction: no `Access-Control-Allow-Origin`
 * header is emitted anywhere here, matching the app-wide posture.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer, resolveMcpAuthContext } from "@/lib/mcp";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { checkMcpRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { ModuleKey } from "@/lib/modules/registry";

// The Bearer resolver + module gate + rate limiter all touch Prisma, so the
// route must run on the Node runtime, never the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_MODULE: ModuleKey = "mcp";

/** One blunt 401 for every authentication failure class — no oracle. */
function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      // Pre-OAuth bridge: a bare Bearer challenge. The RFC 9728
      // `resource_metadata` parameter is added when OAuth discovery lands.
      headers: { "WWW-Authenticate": 'Bearer realm="healthlog-mcp"' },
    },
  );
}

/**
 * Module off → the surface does not exist for this account. A 404 (not a
 * 403) keeps the remote endpoint invisible until the operator / user opts
 * in, so a disabled instance leaks nothing about it.
 */
function moduleDisabled(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** 429 with the standard rate-limit headers. */
function tooManyRequests(resetAt: number, remaining: number): Response {
  const response = Response.json({ error: "rate_limited" }, { status: 429 });
  for (const [k, v] of Object.entries(
    rateLimitHeaders({ allowed: false, remaining, resetAt }),
  )) {
    response.headers.set(k, v);
  }
  return response;
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

async function handleMcp(request: Request): Promise<Response> {
  return withBackgroundEvent("mcp.request", async () => {
    // 1. AUTH — Bearer only; a cookie is never consulted (admin unreachable).
    const raw = readBearer(request);
    if (!raw) {
      annotate({ action: { name: "mcp.auth.missing" } });
      return unauthorized();
    }

    let ctx;
    try {
      ctx = await resolveMcpAuthContext(raw);
    } catch {
      // Do not echo the token or the rejection reason — one blunt 401.
      annotate({ action: { name: "mcp.auth.rejected" } });
      return unauthorized();
    }

    // 2. RATE LIMIT — per `<userId>:<tokenId>` credential binding.
    const rl = await checkMcpRateLimit(ctx.binding);
    if (!rl.allowed) {
      annotate({ action: { name: "mcp.rate_limited" } });
      return tooManyRequests(rl.resetAt, rl.remaining);
    }

    // 3. MODULE GATE — off by default; hide the surface entirely when off.
    if (!(await isModuleEnabled(ctx.userId, MCP_MODULE))) {
      annotate({ action: { name: "mcp.module.disabled" } });
      return moduleDisabled();
    }

    // 4. TRANSPORT — stateless: one fresh server + transport per request.
    annotate({
      action: { name: "mcp.request.served" },
      meta: { method: request.method },
    });

    const server = createMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless mode — no server-held session; each request stands alone.
      sessionIdGenerator: undefined,
      // Buffer a single JSON-RPC response instead of opening an SSE stream;
      // the read tools return one structured result per call.
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      // In JSON-response stateless mode the returned Response is fully
      // buffered before this resolves, so tearing the transport down in the
      // `finally` cannot truncate it.
      return await transport.handleRequest(request);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
