import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.29.x — UX audit H1: the wizard's Withings card must not launch an
 * OAuth handshake that can only 400 for a brand-new account (Withings
 * credentials are per-user BYO with no env fallback). The card reads the
 * consolidated integrations-status envelope and swaps its CTA + href
 * depending on whether the account already has its own credentials saved.
 */

const integrationStatusState = vi.hoisted(() => ({
  data: undefined as
    | {
        threshold: number;
        integrations: Array<{ integration: string; configured?: boolean }>;
      }
    | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: integrationStatusState.data }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SourceCardGrid } from "../source-card-grid";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SourceCardGrid />
    </I18nProvider>,
  );
}

describe("<SourceCardGrid> Withings card", () => {
  it("points at Settings instead of launching OAuth when unconfigured", () => {
    integrationStatusState.data = {
      threshold: 3,
      integrations: [{ integration: "withings", configured: false }],
    };
    const html = render();
    expect(html).toContain('data-testid="source-card-withings-setup"');
    expect(html).toContain('href="/settings/integrations#withings"');
    expect(html).not.toContain('href="/api/withings/connect"');
    expect(html).toContain("Set up in Settings");
  });

  it("also redirects to Settings when the status envelope hasn't loaded yet", () => {
    integrationStatusState.data = undefined;
    const html = render();
    expect(html).toContain('href="/settings/integrations#withings"');
    expect(html).not.toContain('href="/api/withings/connect"');
  });

  it("opens the real OAuth connect flow once credentials are configured", () => {
    integrationStatusState.data = {
      threshold: 3,
      integrations: [{ integration: "withings", configured: true }],
    };
    const html = render();
    expect(html).toContain('href="/api/withings/connect"');
    expect(html).not.toContain('data-testid="source-card-withings-setup"');
    expect(html).toContain("Connect Withings");
  });
});
