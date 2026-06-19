/**
 * v1.18.7 (SECURITY LOW) — host allowlist for local/private AI endpoints.
 *
 * The operator escape-hatch for pointing the server at a self-hosted
 * Ollama / LM Studio on an RFC1918 address used to be a single binary flag,
 * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`, which opened EVERY private/internal
 * host at once — including the cloud-metadata endpoint and any internal admin
 * panel. This narrows it to an explicit allowlist while keeping the binary
 * `true` for backward compatibility:
 *
 *   - unset / "" / "false"      → no private host allowed (the secure default).
 *   - "true"                    → ANY private host allowed (legacy behaviour).
 *   - "ollama.lan, 10.0.0.5"    → ONLY those exact hostnames allowed; every
 *                                 other private host is still rejected.
 *
 * This is layered ON TOP of the `safeFetch` / `isPublicUrl` floor: a public
 * URL never needs the allowlist, and a private host not on the list is
 * rejected exactly as before. The allowlist only ever WIDENS what the
 * operator deliberately permits, never narrows the public-host floor.
 */

const ENV_VAR = "ALLOW_LOCAL_AI_PRIVATE_HOSTS";

/** Parsed allowlist policy from the env var. */
type LocalHostPolicy =
  | { kind: "none" }
  | { kind: "any" }
  | { kind: "hosts"; hosts: ReadonlySet<string> };

function parsePolicy(): LocalHostPolicy {
  const raw = process.env[ENV_VAR]?.trim();
  if (!raw || raw.toLowerCase() === "false") return { kind: "none" };
  if (raw.toLowerCase() === "true") return { kind: "any" };
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  if (hosts.length === 0) return { kind: "none" };
  return { kind: "hosts", hosts: new Set(hosts) };
}

/** Extract the lowercased hostname from a URL string, or null if unparseable. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the operator has explicitly permitted this (private) host for a
 * local AI endpoint. `"true"` permits any host (legacy); a host list permits
 * only listed hostnames. An unparseable URL is never permitted.
 *
 * NOTE: this answers "did the operator opt this host in?", NOT "is this host
 * public?". Callers still run the `isPublicUrl` / `safeFetch` floor; this is
 * the private-host override on top of it.
 */
export function isLocalAiHostAllowed(url: string): boolean {
  const policy = parsePolicy();
  if (policy.kind === "none") return false;
  if (policy.kind === "any") return true;
  const host = hostnameOf(url);
  return host !== null && policy.hosts.has(host);
}

/**
 * Whether `safeFetch` must require a public host for this URL: true unless the
 * operator has opted this private host into the allowlist. Kept as a thin
 * wrapper so the call sites read `requirePublicHost: requirePublicHostFor(url)`
 * and the conditional intent stays obvious.
 */
export function requirePublicHostFor(url: string): boolean {
  return !isLocalAiHostAllowed(url);
}
