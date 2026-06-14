/**
 * v1.17.0 — interaction-parity check for the shared OAuth integration card
 * (Polar / Oura). The new cards must match the existing WHOOP card's
 * parked-state + test-connection + connect→data treatment:
 *
 *   1. A `parked` status renders the warning banner + reconnect button.
 *   2. A `connected` status renders the shared TestConnectionButton (its
 *      "Test connection" affordance) AND the connect→data link.
 *   3. The data link resolves to the provider's insight surface.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Watch } from "lucide-react";

// Drive the card's own `useQuery` status read off a per-test payload.
let statusPayload: unknown = null;
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: statusPayload, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { OAuthProviderCard } from "../oauth-provider-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <OAuthProviderCard
        provider="polar"
        statusQueryKey={["polar"]}
        i18nPrefix="settings.polar"
        icon={Watch}
        dataHref="/insights/sleep"
      />
    </I18nProvider>,
  );
}

describe("OAuthProviderCard — parked + test + data-link parity", () => {
  it("renders the parked banner + reconnect button when state is parked", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      state: "parked",
      lastSuccessAt: null,
      lastError: "Polar grant expired",
    };
    const html = render();
    expect(html).toContain('data-state="parked"');
    expect(html).toContain('data-testid="polar-parked-banner"');
    expect(html).toContain('data-testid="polar-resume-button"');
    expect(html).toContain("reconnect manually");
    // The parked banner uses the same warning treatment as the WHOOP card.
    expect(html).toContain("border-warning/30 bg-warning/10");
  });

  it("renders the test-connection button + data link when connected", () => {
    statusPayload = {
      connected: true,
      configured: true,
      available: true,
      state: "connected",
      lastSuccessAt: "2026-06-01T00:00:00.000Z",
      lastError: null,
    };
    const html = render();
    // The shared TestConnectionButton surfaces its "Test connection" label.
    expect(html).toContain("Test connection");
    // connect→data link points at the provider's insight surface.
    expect(html).toContain('data-testid="polar-data-link"');
    expect(html).toContain('href="/insights/sleep"');
  });

  it("does not render the data link or test button when disconnected", () => {
    statusPayload = {
      connected: false,
      configured: false,
      available: true,
    };
    const html = render();
    expect(html).not.toContain('data-testid="polar-data-link"');
    expect(html).not.toContain("Test connection");
    // The connect CTA stands in instead.
    expect(html).toContain('data-testid="polar-connect"');
  });
});
