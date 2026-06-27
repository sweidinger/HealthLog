import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { PrivacySection } from "../privacy-section";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
  // Seed the privacy summary so the encryption + retention blocks paint inline.
  client.setQueryData(queryKeys.privacySummary(), {
    retention: {
      coachMessagesDays: 365,
      auditLogDays: 365,
      deliveryLogDays: 90,
    },
    encryption: { algorithm: "AES-256-GCM", columnCount: 74, modelCount: 21 },
  });
  // Seed the embedded session + trusted-device + activity reads so the
  // assembled cards paint without firing network.
  client.setQueryData(queryKeys.sessions(), { sessions: [] });
  client.setQueryData(queryKeys.securityActivity(), { events: [] });
  client.setQueryData(queryKeys.trustedDevices(), { devices: [] });
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<PrivacySection> — assembled Data & Privacy dashboard", () => {
  it("renders the assembled sections (encryption, retention, export, delete, sessions, activity)", () => {
    const html = render(<PrivacySection />);
    // Encryption-at-rest block driven from the seeded summary.
    expect(html).toContain("AES-256-GCM");
    // Retention numbers surfaced from the summary.
    expect(html).toContain("365");
    // The honest backup↔deletion lag disclosure is present.
    expect(html.toLowerCase()).toContain("backup");
    // Links to the existing export + destructive surfaces (assembly, not rebuild).
    expect(html).toContain('href="/settings/export"');
    expect(html).toContain('href="/settings/gesundheitsakte"');
    expect(html).toContain('href="/settings/advanced"');
    // Embedded active-session + security-activity cards.
    expect(html).toContain("settings-security-sessions-card");
  });
});
