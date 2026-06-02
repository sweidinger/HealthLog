/**
 * v1.7.0 — AdvancedSettingsSheet composition contract.
 *
 * The sheet hosts five blocks — Reminders → Lifecycle → Data →
 * Externe API → Danger zone — composed from bare section bodies.
 * `<ResponsiveSheet>` wraps Radix portals that `renderToStaticMarkup`
 * does not materialise, so we mock it to a passthrough that renders
 * children only when `open` and echoes `contentWidth`. The bodies are
 * mocked to ordered markers. The test pins:
 *   - the five blocks render in the documented order;
 *   - the external-API row lives in its own group, not in Data;
 *   - the sheet opens at the `2xl` width token;
 *   - `onRequestPhaseSheet` threads through to the phases row;
 *   - `onOpenImport` wires the import button (co-located with export);
 *   - the export control sits beside the import control;
 *   - the lifecycle + danger bodies receive an `onAfterAction` closer;
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
    contentWidth,
  }: {
    open: boolean;
    children: React.ReactNode;
    title: React.ReactNode;
    contentWidth?: string;
  }) =>
    open ? (
      <div data-slot="mock-responsive-sheet" data-content-width={contentWidth}>
        <div data-slot="mock-title">{title}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/components/medications/sections/api-tokens-row", () => ({
  ApiTokensRow: () => <div data-slot="mock-api-tokens" />,
}));

vi.mock("@/components/medications/sections/notifications-section", () => ({
  NotificationsBody: () => <div data-slot="mock-notifications" />,
}));

vi.mock("@/components/medications/sections/settings-section", () => ({
  GraceRow: () => <div data-slot="mock-grace" />,
  DrugCodingRow: () => <div data-slot="mock-drug-coding" />,
  PhasesRow: ({
    onRequestPhaseSheet,
  }: {
    onRequestPhaseSheet?: () => void;
  }) => (
    <div
      data-slot="mock-phases"
      data-has-phase-swap={onRequestPhaseSheet ? "yes" : "no"}
    />
  ),
}));

vi.mock("@/components/medications/sections/destructive-zone-section", () => ({
  LifecycleManageBody: ({ onAfterAction }: { onAfterAction?: () => void }) => (
    <div
      data-slot="mock-lifecycle"
      data-has-after-action={onAfterAction ? "yes" : "no"}
    />
  ),
  DangerZoneBody: ({ onAfterAction }: { onAfterAction?: () => void }) => (
    <button
      data-slot="mock-danger"
      data-has-after-action={onAfterAction ? "yes" : "no"}
      onClick={onAfterAction}
    />
  ),
}));

import { AdvancedSettingsSheet } from "@/components/medications/advanced-settings-sheet";

function baseProps(
  open: boolean,
  extra: Partial<{
    onRequestPhaseSheet: () => void;
    onOpenImport: () => void;
  }> = {},
) {
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
    ...extra,
  };
}

describe("AdvancedSettingsSheet (v1.7.0)", () => {
  it("renders the five blocks in Reminders → Lifecycle → Data → Externe API → Danger order", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet
        {...baseProps(true, { onRequestPhaseSheet: () => {} })}
      />,
    );
    const reminders = html.indexOf("advanced-group-reminders");
    const lifecycle = html.indexOf("advanced-group-lifecycle");
    const data = html.indexOf("advanced-group-data");
    const externalApi = html.indexOf("advanced-group-external-api");
    const danger = html.indexOf("mock-danger");
    expect(reminders).toBeGreaterThan(-1);
    expect(lifecycle).toBeGreaterThan(reminders);
    expect(data).toBeGreaterThan(lifecycle);
    expect(externalApi).toBeGreaterThan(data);
    expect(danger).toBeGreaterThan(externalApi);
  });

  it("homes the external-API row in its own group, not in the Data group", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    // The API row marker must sit after the external-API group opens,
    // not inside the Data group it used to share.
    const dataGroup = html.indexOf("advanced-group-data");
    const externalApiGroup = html.indexOf("advanced-group-external-api");
    const apiRow = html.indexOf("mock-api-tokens");
    expect(apiRow).toBeGreaterThan(externalApiGroup);
    expect(externalApiGroup).toBeGreaterThan(dataGroup);
  });

  it("opens at the 2xl width token", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    expect(html).toContain('data-content-width="2xl"');
  });

  it("threads onRequestPhaseSheet through to the phases row", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet
        {...baseProps(true, { onRequestPhaseSheet: () => {} })}
      />,
    );
    expect(html).toContain('data-has-phase-swap="yes"');
  });

  it("wires the import button", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet
        {...baseProps(true, { onOpenImport: () => {} })}
      />,
    );
    expect(html).toContain("advanced-import-button");
    expect(html).toContain(
      "medications.detail.advanced.dataPortability.import.button",
    );
  });

  it("co-locates an export control beside the import control", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    expect(html).toContain("advanced-export-button");
    expect(html).toContain(
      "medications.detail.advanced.dataPortability.export.button",
    );
    const importIdx = html.indexOf("advanced-import-block");
    const exportIdx = html.indexOf("advanced-export-block");
    expect(importIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeGreaterThan(importIdx);
  });

  it("passes an onAfterAction to the lifecycle and danger bodies so they can close the sheet", () => {
    const html = renderToStaticMarkup(
      <AdvancedSettingsSheet {...baseProps(true)} />,
    );
    const lifecycle = html.match(
      /mock-lifecycle"[^>]*data-has-after-action="yes"/,
    );
    const danger = html.match(/mock-danger"[^>]*data-has-after-action="yes"/);
    expect(lifecycle).not.toBeNull();
    expect(danger).not.toBeNull();
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
