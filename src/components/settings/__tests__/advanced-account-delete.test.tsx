/**
 * v1.4.43 QoL (M3 + L5) — danger-zone shaping.
 *
 *   M3: a separate "Delete account entirely" destructive card
 *       (`AccountDeleteCard`) gives the GDPR Article 17 full-erasure CTA its
 *       own surface alongside the half-erasure data reset.
 *
 *   L5: the data-reset card no longer paints a red `AlertTriangle`
 *       icon and the title sits in the neutral foreground colour
 *       (mirrors GitHub's danger-zone shaping). The CTA button stays
 *       red; the protective confirmation dialog stays unchanged.
 *
 * v1.25.1 (Q2-M3): account deletion moved out of `<AdvancedSection>` (Data &
 * Privacy group) into the Account group as a standalone `<AccountDeleteCard>`.
 * The L5 data-reset assertions still target `<AdvancedSection>`; the M3
 * account-delete assertions now render the relocated card directly.
 *
 * SSR-only — we render the component statically and inspect the
 * markup. The mutation handlers don't fire in SSR, so this test only
 * pins the visible structure + copy.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// `<AdvancedSection>` mounts the Research Mode card which calls
// `useQuery` and `useQueryClient` under TanStack Query. The other
// shape tests use the same stub.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/medications/research-mode-acknowledgment-dialog", () => ({
  ResearchModeAcknowledgmentDialog: () => <div data-slot="mock-ack-dialog" />,
}));

import { AdvancedSection } from "../advanced-section";
import { AccountDeleteCard } from "../account-delete-card";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AdvancedSection />
    </I18nProvider>,
  );
}

function renderDeleteCard(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AccountDeleteCard />
    </I18nProvider>,
  );
}

describe("<AdvancedSection> danger-zone shaping (v1.4.43 L5)", () => {
  it("mounts the data-reset card", () => {
    const html = render();
    expect(html).toContain('data-slot="settings-data-reset-card"');
  });

  it("v1.25.1 (Q2-M3): no longer mounts the account-delete card", () => {
    // Account deletion graduated to the Account group; Advanced keeps research
    // mode + the data reset only.
    const html = render();
    expect(html).not.toContain('data-slot="settings-account-delete-card"');
  });

  it("L5: the data-reset card title is neutral foreground (no destructive red)", () => {
    const html = render();
    // The reset card's title used to ship with `text-destructive`; the
    // v1.4.43 fix pins it on `text-foreground`. We don't care if other
    // strings in the section happen to use `text-destructive` (the CTA
    // button does), only that the specific card title slot does NOT.
    const cardMatch = html.match(
      /data-slot="settings-data-reset-card"[\s\S]*?<\/h2>/,
    );
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).toContain("text-foreground");
    expect(cardMatch![0]).not.toContain("text-destructive");
  });

  it("L5: the data-reset card no longer ships an AlertTriangle icon", () => {
    const html = render();
    // The icon used to render with a lucide-issued `lucide-alert-triangle`
    // class. Pin the absence; if a future revision re-imports the icon
    // the SVG class will reappear and this test catches it.
    const cardMatch = html.match(
      /data-slot="settings-data-reset-card"[\s\S]*?<\/h2>/,
    );
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).not.toMatch(/lucide-alert-triangle/);
  });
});

describe("<AccountDeleteCard> (v1.4.43 M3, relocated v1.25.1 Q2-M3)", () => {
  it("renders the account-delete card", () => {
    const html = renderDeleteCard();
    expect(html).toContain('data-slot="settings-account-delete-card"');
  });

  it("M3: the account-delete card uses the destructive Button variant", () => {
    const html = renderDeleteCard();
    expect(html).toContain('data-slot="settings-account-delete-trigger"');
    // The trigger button still wears the destructive style — the CTA
    // remains red even though the surrounding card chrome is neutral.
    const triggerMatch = html.match(
      /data-slot="settings-account-delete-trigger"[\s\S]*?<\/button>/,
    );
    expect(triggerMatch).not.toBeNull();
    // The destructive button uses the `bg-destructive` class from the
    // shadcn variant.
    expect(triggerMatch![0]).toContain("bg-destructive");
  });

  it("M3: the account-delete card surfaces tight DE copy under the 'de' locale", () => {
    const html = renderDeleteCard("de");
    expect(html).toContain("Konto vollständig löschen");
    // The descriptive sentence calls out the cascade scope plainly.
    expect(html).toContain("Passkeys");
  });

  it("M3: the account-delete card surfaces tight EN copy under the 'en' locale", () => {
    const html = renderDeleteCard("en");
    expect(html).toContain("Delete account entirely");
    expect(html).toContain("passkeys");
  });
});
