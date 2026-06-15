import { getEvent } from "@/lib/logging/context";

/**
 * Operator-supplied SMTP transport config (v1.17.1).
 *
 * Mirrors the APNs pattern (`loadApnsConfig`): the transport credentials live
 * once in the operator's env, NOT in every user's encrypted channel blob. When
 * the required vars are absent the channel is simply never offered — a
 * self-hoster who hasn't set up SMTP sees no Email card and the dispatcher
 * skips the channel cleanly rather than throwing on every send.
 *
 * Required: SMTP_HOST, SMTP_PORT, SMTP_FROM.
 * Optional: SMTP_USER + SMTP_PASS (omit for an unauthenticated relay),
 *           SMTP_SECURE ("true" → implicit TLS on connect, typically port 465;
 *           default false → STARTTLS upgrade, typically port 587).
 */
export interface EmailTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: { user: string; pass: string };
}

let cachedConfig: EmailTransportConfig | null | undefined;

export function loadEmailConfig(): EmailTransportConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const host = process.env.SMTP_HOST?.trim() || "";
  const portRaw = process.env.SMTP_PORT?.trim() || "";
  const from = process.env.SMTP_FROM?.trim() || "";
  const user = process.env.SMTP_USER?.trim() || "";
  const pass = process.env.SMTP_PASS?.trim() || "";
  const secure = process.env.SMTP_SECURE?.trim().toLowerCase() === "true";

  // All-or-none guard mirroring APNs: zero set → silently disabled (no
  // warning). Some-but-not-all set → the operator started configuring and
  // stopped; surface that as a warning so the half-finished state is visible
  // the moment a send is attempted.
  const anySet = Boolean(host || portRaw || from || user || pass);
  const port = Number(portRaw);
  const allSet = Boolean(host && portRaw && from && Number.isFinite(port));

  if (!anySet) {
    cachedConfig = null;
    return null;
  }

  if (!allSet) {
    getEvent()?.addWarning(
      "SMTP config incomplete — set SMTP_HOST, SMTP_PORT, and SMTP_FROM " +
        "together (SMTP_USER/SMTP_PASS optional). Email channel is disabled " +
        "until all three are present.",
    );
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    host,
    port,
    secure,
    from,
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
  return cachedConfig;
}

/** True when the operator has configured an SMTP transport. */
export function isEmailConfigured(): boolean {
  return loadEmailConfig() !== null;
}

/** Test-only: clear the per-process cache so env changes take effect. */
export function resetEmailConfigForTesting(): void {
  cachedConfig = undefined;
}
