/**
 * v1.5.6 G-1 §5 — AdvancedSettingsSheet composition contract.
 *
 * The sheet hosts the three moved sections in routine → rare →
 * destructive order: Notifications → Settings → destructive zone.
 * `<ResponsiveSheet>` wraps Radix portals that `renderToStaticMarkup`
 * does not materialise, so we mock it to a passthrough that renders
 * children only when `open`, and mock the three sections to ordered
 * markers. The test pins:
 *   - the three sections render in the documented order;
 *   - `onRequestPhaseSheet` threads through to `<SettingsSection>`;
 *   - the destructive zone's `onAfterAction` closes the sheet;
 *   - the sheet renders nothing when `open` is false.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    children,
    title,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: React.ReactNode;
  }) =>
    open ? (
      <div data-slot="mock-responsive-sheet">
        <div data-slot="mock-title">{title}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock(
  "@/components/medications/sections/notifications-section",
  () => ({
    NotificationsSection: () => <div data-slot="mock-notifications" />,
  }),
);

vi.mock("@/components/medications/sections/settings-section", () => ({
  SettingsSection: ({
    onRequestPhaseSheet,
  }: {
    onRequestPhaseSheet?: () => void;
  }) => (
    <div
      data-slot="mock-settings"
      data-has-phase-swap={onRequestPhaseSheet ? "yes" : "no"}
    />
  ),
}));

vi.mock(
  "@/components/medications/sections/destructive-zone-section",
  () => ({
    DestructiveZoneSection: ({
      onAfterAction,
    }: {
      onAfterAction?: () => void;
    }) => (
      <button
        data-slot="mock-destructive"
        data-has-after-action={onAfterAction ? "yes" : "no"}
        onClick={onAfterAction}
      />
    ),
  }),
);

import { AdvancedSettingsSheet } from "@/components/medications/advanced-settings-sheet";

function baseProps(open: boolean, onRequestPhaseSheet?: () => void) {
  return {
    open,
    onOpenChange: () => {},
    medicationId: "med-1",
    medicationName: "Test Drug",
    treatmentClass: "GLP1",
    active: true,
    startsOn: "2026-01-01",
    endsOn: "2026-06-01",
    notificationsEnabled: true,
    reminderGraceMinutes: 30,
    intakeCount: 5,
    onRequestPhaseSheet,
  };
}

describe("AdvancedSettingsSheet (G-1 §5)", () => {
  it("renders the three sections in routine → rare → destructive order", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true, () => {})} />,
    );
    const notif = html.indexOf("mock-notifications");
    const settings = html.indexOf("mock-settings");
    const destructive = html.indexOf("mock-destructive");
    expect(notif).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(notif);
    expect(destructive).toBeGreaterThan(settings);
  });

  it("threads onRequestPhaseSheet through to the settings section", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true, () => {})} />,
    );
    expect(html).toContain('data-has-phase-swap="yes"');
  });

  it("passes an onAfterAction to the destructive zone so it can close the sheet", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    expect(html).toContain('data-has-after-action="yes"');
  });

  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(false)} />,
    );
    expect(html).toBe("");
  });

  it("titles the sheet with the advanced-settings key", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    expect(html).toContain("medications.detail.advanced.title");
  });
});
