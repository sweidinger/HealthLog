/**
 * v1.23 — HaveIBeenPwned password-breach check via the k-anonymity range API.
 *
 * Privacy contract (the whole point of k-anonymity): the password is SHA-1'd
 * locally and ONLY the first 5 hex characters of the uppercase digest leave the
 * server. The remaining 35-character suffix is matched against the response
 * locally; the full hash and the password itself never cross the network. The
 * request carries `Add-Padding: true` so the response size does not leak which
 * prefix bucket was queried.
 *
 * Resilience: any failure (egress disabled, HIBP down, timeout, non-200,
 * malformed body) returns `null` — "unknown". Callers treat `null` as
 * fail-open and never block on it; only a confirmed breach (`breached: true`)
 * is actionable. The check is therefore safe to run inline at password-set
 * time without making HIBP a hard dependency of account management.
 */
import { createHash } from "node:crypto";
import { safeFetch } from "@/lib/safe-fetch";
import { getEvent } from "@/lib/logging/context";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

export interface BreachCheckResult {
  breached: boolean;
  /** Number of times the password appears in the corpus (0 when not found). */
  count: number;
}

/**
 * Returns the breach status of `password`, or `null` when the check could not
 * be completed (fail-open). Never throws.
 */
export async function checkPasswordBreach(
  password: string,
): Promise<BreachCheckResult | null> {
  try {
    const digest = createHash("sha1")
      .update(password, "utf8")
      .digest("hex")
      .toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    const res = await safeFetch(
      `${HIBP_RANGE_URL}${prefix}`,
      {
        method: "GET",
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(4000),
      },
      // The host is a fixed, app-controlled public endpoint, but pin the
      // public-host / DNS-rebinding guard anyway — it is a hard egress, and the
      // SSRF floor is cheap.
      { requirePublicHost: true },
    );

    if (!res.ok) return null;

    const body = await res.text();
    // Each line: "<35-hex-suffix>:<count>". Compare case-insensitively.
    for (const line of body.split("\n")) {
      const sep = line.indexOf(":");
      if (sep < 0) continue;
      const lineSuffix = line.slice(0, sep).trim().toUpperCase();
      if (lineSuffix === suffix) {
        const count = parseInt(line.slice(sep + 1).trim(), 10);
        return { breached: true, count: Number.isFinite(count) ? count : 1 };
      }
    }
    return { breached: false, count: 0 };
  } catch (err) {
    getEvent()?.addWarning(
      `HIBP breach check unavailable (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
