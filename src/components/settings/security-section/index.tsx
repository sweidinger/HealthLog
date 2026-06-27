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
import { TrustedDevicesCard } from "@/components/settings/trusted-devices-card";

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

  if (isLoading || !status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showNudge && <PasskeyUpgradeNudge />}

      <TotpCard
        enabled={status.totp.enabled}
        recoveryCodesRemaining={status.recoveryCodesRemaining}
      />

      <SecurityKeysCard keys={status.webauthn} />

      <PasskeyListSection isAuthenticated={isAuthenticated} />

      <TrustedDevicesCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
