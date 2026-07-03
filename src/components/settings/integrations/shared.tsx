"use client";

/**
 * Shared types + status plumbing for the Settings → Integrations cards.
 * Extracted from the former 1.6k-LOC `integrations-section.tsx`
 * monolith; one card per integration lives next to this module under
 * `src/components/settings/integrations/`.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";

import type { IntegrationPillState } from "@/components/settings/integration-status-pill";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

// v1.4.15 Phase B2: shared status payload for both integration cards.
// v1.4.19 Phase A5: the redundant in-card status banner is gone — the
// IntegrationStatusPill now owns state + last-sync presentation, and
// the actionable error message is shown inline above the action row.
export type IntegrationKey =
  | "withings"
  | "whoop"
  | "fitbit"
  | "moodlog"
  | "polar"
  | "oura"
  // v1.27.0 — Google Health (Fitbit + Pixel Watch + Fitbit Air).
  | "google-health";
export type IntegrationState =
  "connected" | "error_transient" | "error_reauth" | "disconnected" | "parked";

export interface IntegrationStatusViewModel {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  configured?: boolean;
  connected?: boolean;
  connectedAt?: string | null;
  legacyLastSyncedAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean | null;
  enabled?: boolean;
  // Withings activity-scope reconnect banner.
  scope?: string | null;
  hasActivityScope?: boolean;
  // WHOOP / Fitbit backfill-in-progress note.
  backfillCompleted?: boolean | null;
  // v1.27.0 — Google Health surfaces `needsReauth` when the refresh token has
  // lapsed (the 7-day "Testing"-mode expiry, or a revoked grant). The card
  // paints a distinct re-consent CTA off this flag, separate from the parked
  // state. Server-populated on the `/api/integrations/status` envelope.
  needsReauth?: boolean;
  // moodLog webhook secret + entry count.
  webhookSecret?: string | null;
  entryCount?: number;
  // Polar / Oura OAuth card: usable-credentials + BYO-key flags. `available`
  // greys out the connect button when no credentials resolve; `hasOwnCredentials`
  // drives the saved-placeholder UI.
  available?: boolean;
  hasOwnCredentials?: boolean;
}

export interface IntegrationStatusEnvelope {
  threshold: number;
  integrations: IntegrationStatusViewModel[];
}

/**
 * Shared status fetch for the Settings → Integrations card. Returns
 * the per-integration view-model AND the global threshold so the
 * "{n}/{threshold} consecutive failures" string in the UI is single-
 * sourced from the server.
 */
export function useIntegrationStatuses(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.integrationsStatus(),
    queryFn: async () => {
      return apiGet<IntegrationStatusEnvelope>("/api/integrations/status");
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function pickStatus(
  envelope: IntegrationStatusEnvelope | undefined,
  integration: IntegrationKey,
): IntegrationStatusViewModel | undefined {
  return envelope?.integrations.find((i) => i.integration === integration);
}

/**
 * Collapse the API's five-state machine into the four states the
 * pill UI cares about. `error_transient` and `error_reauth` both
 * surface as the same "Error — reconnect" pill, the actionable
 * difference (whether the user must reconnect vs wait for the next
 * retry) is conveyed via the inline error text underneath. `parked`
 * (v1.4.43 W14) is its own pill state — the integration has been
 * disabled after 24h of persistent failures and needs an explicit
 * "Wieder verbinden" click to resume.
 */
export function pillStateFor(
  status: IntegrationStatusViewModel | undefined,
): IntegrationPillState {
  if (!status) return "disconnected";
  switch (status.state) {
    case "connected":
      return "connected";
    case "error_transient":
      // v1.4.43 W4 H3 — a `persistent` failure-kind streak (Withings
      // rate-limit 601 / contract-mismatch 293/294) maps to the same
      // `error_transient` DB state as a normal retryable failure but
      // tells the user a different story: the access token still
      // works, the upstream is responding with a non-recoverable
      // status. Surfacing it as a "warning" pill (orange) instead of
      // the red "Fehler — neu verbinden" stops the user from clicking
      // reconnect ten times when reconnect can't fix it.
      if ((status.consecutiveFailuresByKind?.persistent ?? 0) > 0) {
        return "warning";
      }
      return "error";
    case "error_reauth":
      return "error";
    case "parked":
      return "parked";
    case "disconnected":
      return "disconnected";
  }
}

/**
 * Inline actionable error message that surfaces under the pill when a
 * sync attempt failed. The pill conveys "something is wrong"; this
 * line tells the user *what* is wrong so they can act on it. Keeping
 * it deliberately small (one icon + one line) so it doesn't recreate
 * the v1.4.18 redundant banner the maintainer removed.
 */
export function IntegrationErrorMessage({ message }: { message: string }) {
  return (
    <p
      data-testid="integration-error-message"
      className="text-destructive flex items-start gap-1.5 text-sm"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}
