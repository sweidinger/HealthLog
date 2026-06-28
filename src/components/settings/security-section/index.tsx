"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { TotpCard } from "./totp-card";
import { SecurityKeysCard, type WebauthnKeyInfo } from "./security-keys-card";
import { PasskeyListSection } from "./passkey-list-section";
import { PasskeyUpgradeNudge } from "./passkey-upgrade-nudge";
// v1.25.1 (H1) — active sessions, trusted devices, and the login-activity feed
// are "who/what can sign in as me" — the same mental model as the second-factor
// and passkey controls above. They used to live in the Data & Privacy group
// (split across two top-level groups); they now sit here in Account → Security
// as the single sign-in-management home.
import { SecuritySessionsCard } from "@/components/settings/security-sessions-card";
import { TrustedDevicesCard } from "@/components/settings/trusted-devices-card";
import { SecurityActivityCard } from "@/components/settings/security-activity-card";

interface MfaStatus {
  totp: { enabled: boolean };
  recoveryCodesRemaining: number;
  webauthn: WebauthnKeyInfo[];
  passkeyNudgeDismissed: boolean;
}

interface PasskeyInfo {
  id: string;
}

export function SecuritySection() {
  const { isAuthenticated } = useAuth();

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.mfaStatus(),
    queryFn: async () => apiGet<MfaStatus>("/api/auth/me/mfa"),
    enabled: isAuthenticated,
  });

  // Passkey count drives whether the upgrade nudge shows. Shares the cached
  // `passkeys()` key with the list below, so this is not an extra round-trip.
  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => apiGet<PasskeyInfo[]>("/api/auth/passkeys"),
    enabled: isAuthenticated,
  });

  const showNudge =
    status != null &&
    !status.passkeyNudgeDismissed &&
    passkeys != null &&
    passkeys.length === 0;

  // The second-factor / passkey cards depend on the MFA status payload, so they
  // skeleton while it loads. The session / device / activity cards own their own
  // reads and loading states, so they render unconditionally below — a slow or
  // failed `/api/auth/me/mfa` must never hide active-session revocation.
  const mfaCards =
    isLoading || !status ? (
      <>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </>
    ) : (
      <>
        {showNudge && <PasskeyUpgradeNudge />}

        <TotpCard
          enabled={status.totp.enabled}
          recoveryCodesRemaining={status.recoveryCodesRemaining}
        />

        <SecurityKeysCard keys={status.webauthn} />

        <PasskeyListSection isAuthenticated={isAuthenticated} />
      </>
    );

  return (
    <div className="space-y-6">
      {mfaCards}

      {/* v1.25.1 (H1) — sign-in management consolidated here. */}
      <SecuritySessionsCard isAuthenticated={isAuthenticated} />
      <TrustedDevicesCard isAuthenticated={isAuthenticated} />
      <SecurityActivityCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
