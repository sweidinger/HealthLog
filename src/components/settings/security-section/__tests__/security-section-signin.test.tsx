/**
 * v1.25.1 (H1) — sign-in management consolidation.
 *
 * Active sessions, trusted devices, and the login-activity feed moved out of
 * the Data & Privacy group into Account → Security so every "who can sign in as
 * me" control sits in one place. This SSR test pins that the three cards render
 * inside `<SecuritySection>`.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { SecuritySection } from "../index";

function render() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
  // Seed the MFA status so the second-factor cards paint instead of skeletons.
  client.setQueryData(queryKeys.mfaStatus(), {
    totp: { enabled: false },
    recoveryCodesRemaining: 0,
    webauthn: [],
    passkeyNudgeDismissed: true,
  });
  client.setQueryData(queryKeys.passkeys(), []);
  // Seed the embedded sign-in reads so the cards paint without firing network.
  client.setQueryData(queryKeys.sessions(), { sessions: [] });
  client.setQueryData(queryKeys.securityActivity(), { events: [] });
  client.setQueryData(queryKeys.trustedDevices(), {
    devices: [
      {
        id: "td-1",
        label: "Firefox on macOS",
        isCurrent: true,
        createdAt: "2099-01-01T00:00:00.000Z",
        lastUsedAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <SecuritySection />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<SecuritySection> — sign-in management home (H1)", () => {
  it("renders the active-session, trusted-device, and security-activity cards", () => {
    const html = render();
    expect(html).toContain('data-slot="settings-security-sessions-card"');
    expect(html).toContain('data-slot="settings-trusted-devices-card"');
    expect(html).toContain('data-slot="settings-security-activity-card"');
  });
});
