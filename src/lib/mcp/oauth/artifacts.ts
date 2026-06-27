/**
 * Signed, self-describing OAuth artifacts (stateless bridge).
 *
 * The minimal AS keeps NO new identity tables (ADR-006). The three short-lived
 * OAuth artifacts it mints — the authorization code, the refresh token, and the
 * Dynamic-Client-Registration client id — are instead HMAC-signed, tamper-proof,
 * self-describing strings. Each carries its own claims and is verified by
 * recomputing the signature in constant time; nothing is looked up in a table.
 *
 * Only the ACCESS token is a real persisted row: it is an ordinary `hlk_`
 * `ApiToken` minted through `issue-token.ts`, so the existing revoke / expiry /
 * `lastUsedAt` machinery and the `<userId>:<tokenId>` binding all apply to it
 * unchanged. The artifacts here exist only to carry grant state BETWEEN the
 * authorize and token steps without inventing a parallel store.
 *
 * Signing key: `API_TOKEN_HMAC_KEY` (the same fail-closed key the Bearer hasher
 * uses — `hashToken` validates length ≥ 32). Each artifact class is domain-
 * separated by a context label folded into the MAC input, so a code can never be
 * presented as a refresh token or a client id, and vice-versa.
 *
 * The signed value is `<prefix>.<base64url(payload)>.<base64url(mac)>`. The
 * payload always carries an `exp` (epoch ms) which `verifyArtifact` enforces.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Artifact classes, each with a stable prefix + domain-separation label. */
export const ARTIFACT_KINDS = {
  authCode: { prefix: "hlac_", context: "mcp.oauth.auth_code.v1" },
  refreshToken: { prefix: "hlrt_", context: "mcp.oauth.refresh.v1" },
  clientId: { prefix: "hlc_", context: "mcp.oauth.client.v1" },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_KINDS;

function signingKey(): string {
  const key = process.env.API_TOKEN_HMAC_KEY;
  if (!key || key.length < 32) {
    // Fail closed — never sign an OAuth artifact off weak / missing key
    // material (mirrors `hashToken`).
    throw new Error(
      "API_TOKEN_HMAC_KEY must be set and at least 32 characters",
    );
  }
  return key;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function mac(context: string, payloadB64: string): string {
  return createHmac("sha256", signingKey())
    .update(`${context}.${payloadB64}`)
    .digest("hex");
}

/**
 * Mint a signed artifact. `claims` is merged with `exp` (now + `ttlMs`) and
 * serialised; the caller never sets `exp` itself.
 */
export function signArtifact(
  kind: ArtifactKind,
  claims: Record<string, unknown>,
  ttlMs: number,
): string {
  const { prefix, context } = ARTIFACT_KINDS[kind];
  const payload = { ...claims, exp: Date.now() + ttlMs };
  const payloadB64 = b64url(JSON.stringify(payload));
  // `mac` returns hex; base64url the RAW bytes so `verifyArtifact` can compare
  // against `Buffer.from(expectedSig, "hex")` byte-for-byte.
  const sig = b64url(Buffer.from(mac(context, payloadB64), "hex"));
  return `${prefix}${payloadB64}.${sig}`;
}

export type VerifyResult<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify + decode a signed artifact. Returns the claims on success, or a stable
 * machine reason on failure. The signature is checked in constant time and the
 * `exp` claim is enforced. A wrong-kind artifact fails on `malformed` (prefix
 * mismatch) or `bad_signature` (domain-separation label mismatch).
 */
export function verifyArtifact<T = Record<string, unknown>>(
  kind: ArtifactKind,
  value: string,
): VerifyResult<T> {
  const { prefix, context } = ARTIFACT_KINDS[kind];
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    return { ok: false, reason: "malformed" };
  }
  const body = value.slice(prefix.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);

  const expectedSig = mac(context, payloadB64);
  const presented = b64urlDecode(sigB64);
  const expected = Buffer.from(expectedSig, "hex");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: T & { exp?: number };
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
