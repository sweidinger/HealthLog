/**
 * v1.4.15 Phase B2 — Settings → Integrations status surface tests.
 *
 * The four states this file locks in (one assertion each):
 *   1. connected           → no banner, "Connected" badge only
 *   2. error_transient     → banner with "{count}/{threshold}"
 *                            counter, last-error message visible
 *   3. error_reauth        → "Reconnect required" badge surfaces
 *   4. disconnected        → "Disconnected" badge surfaces (used
 *                            after the user clicks "Disconnect")
 *
 * We test by rendering only the IntegrationsSection with a TanStack
 * Query mock that returns the desired status. The other queries
 * (withings status, moodlog status, global services) are stubbed to
 * stable defaults — the test isn't about those surfaces.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/integrations",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// Per-test mock — we'll rewrite the integration-status payload between
// cases via `setIntegrationStatus()`. Withings + moodlog status return
// stable defaults so the cards render their connect-CTA branch (the
// banner is what we actually assert on).
let integrationStatusPayload: unknown = null;
function setIntegrationStatus(payload: unknown) {
  integrationStatusPayload = payload;
}

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "integrations/status") {
      return { data: integrationStatusPayload, isLoading: false };
    }
    if (key === "settings/global-services") {
      return {
        data: {
          telegramGlobal: true,
          ntfyGlobal: true,
          webPushGlobal: true,
          apiGlobal: true,
          moodLogGlobal: true,
        },
        isLoading: false,
      };
    }
    if (key === "withings/status") {
      return {
        data: { connected: false, configured: false },
        isLoading: false,
      };
    }
    if (key === "moodlog-status") {
      return {
        data: {
          configured: false,
          enabled: false,
          lastSyncedAt: null,
          entryCount: 0,
          webhookSecret: null,
        },
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    return { data: null, isLoading: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { IntegrationsSection } from "../integrations-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IntegrationsSection />
    </I18nProvider>,
  );
}

describe("IntegrationsSection — status surface", () => {
  beforeEach(() => {
    integrationStatusPayload = null;
  });

  it("renders no error banner when both integrations are healthy", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: "2026-05-09T18:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    const html = render();
    expect(html).not.toContain("Reconnect required");
    expect(html).not.toContain("integration-status-error");
  });

  it("surfaces an error banner with last-error and {n}/{threshold} when transient failure", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "error_transient",
          lastSuccessAt: "2026-05-09T08:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: "Withings refresh error: 503 - upstream",
          consecutiveFailures: 2,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    const html = render();
    expect(html).toContain("2/3 consecutive failures");
    expect(html).toContain("Withings refresh error: 503 - upstream");
    expect(html).toContain("integration-status-banner");
  });

  it("surfaces 'Reconnect required' when a refresh-token grant has revoked", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "error_reauth",
          lastSuccessAt: "2026-05-08T12:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: "Withings refresh error: 100 - invalid_grant",
          consecutiveFailures: 1,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    const html = render();
    expect(html).toContain("Reconnect required");
  });

  it("renders the disconnected tombstone state without error styling", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
        {
          integration: "moodlog",
          state: "disconnected",
          lastSuccessAt: "2026-05-08T10:00:00.000Z",
          lastAttemptAt: "2026-05-08T10:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    const html = render();
    expect(html).toContain("Disconnected");
    expect(html).not.toContain("Reconnect required");
  });
});
