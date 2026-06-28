/**
 * OAuth discovery documents — RFC 9728 (Protected Resource Metadata) + RFC 8414
 * (Authorization Server Metadata).
 *
 * These two JSON documents are how a remote MCP client bootstraps the flow from
 * nothing but the pasted `/mcp` URL:
 *
 *   1. The client calls `/mcp`, gets a `401` whose `WWW-Authenticate` points at
 *      `/.well-known/oauth-protected-resource` (PRM).
 *   2. PRM names this `resource` (the canonical `/mcp` URI — it MUST match the
 *      user-entered URL) and lists its `authorization_servers`.
 *   3. The client fetches the AS metadata and learns the `/authorize` + `/token`
 *      + `/register` endpoints, that **PKCE S256 is mandatory**, and that the AS
 *      accepts **CIMD** clients (`client_id_metadata_document_supported: true` +
 *      `none` auth) with **DCR** as a fallback.
 *
 * Everything is anchored to the canonical origin (`config.ts`) so the documents
 * are deterministic and the audience can be validated against them.
 */
import {
  canonicalResource,
  resolveBaseOrigin,
  SUPPORTED_SCOPES,
} from "./config";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
}

/** RFC 9728 — the Protected Resource Metadata for the `/mcp` resource. */
export function protectedResourceMetadata(
  requestUrl?: string,
): ProtectedResourceMetadata {
  const origin = resolveBaseOrigin(requestUrl);
  return {
    resource: canonicalResource(requestUrl),
    authorization_servers: [origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 — the Authorization Server Metadata for the built-in bridge AS. */
export function authorizationServerMetadata(
  requestUrl?: string,
): AuthorizationServerMetadata {
  const origin = resolveBaseOrigin(requestUrl);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public clients only — PKCE is the proof of possession, not a secret.
    token_endpoint_auth_methods_supported: ["none"],
    // S256 ONLY — `plain` is structurally unsupported (RFC 7636 + connectors).
    code_challenge_methods_supported: ["S256"],
    // CIMD is the preferred registration path (SEP-991); DCR is the fallback.
    client_id_metadata_document_supported: true,
    // RFC 9207 — the authorization response carries an `iss` parameter the
    // client validates against this metadata's `issuer`, so a code from a
    // look-alike AS in a multi-AS deployment cannot be substituted (mix-up
    // defence). The `/authorize` redirect always includes it.
    authorization_response_iss_parameter_supported: true,
  };
}

/** Build the `WWW-Authenticate` value pointing a 401 at the PRM (RFC 9728). */
export function wwwAuthenticateChallenge(
  requestUrl?: string,
  scope?: string,
): string {
  const origin = resolveBaseOrigin(requestUrl);
  const prm = `${origin}/.well-known/oauth-protected-resource`;
  const parts = ['Bearer realm="healthlog-mcp"', `resource_metadata="${prm}"`];
  if (scope) parts.push(`scope="${scope}"`);
  return parts.join(", ");
}
