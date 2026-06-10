/**
 * v1.5.6 G-1 §9 Q1 — IntakeEditDialog seeds from the row's real
 * values.
 *
 * Before this pass the preview opened the dialog with a stub
 * `{ id, takenAt: null, skipped: false }`, so "Bearbeiten" always
 * showed an empty form. The fix threads the whole `IntakeEvent` up
 * through `onEditIntake(event)`; this test pins that the dialog's
 * datetime-local input + skipped switch seed from the event passed in.
 *
 * `<Dialog>` wraps a Radix portal that `renderToStaticMarkup` does not
 * materialise, so we mock the dialog primitives to passthroughs.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
  useFormatters: () => ({
    dateTime: (value: string | Date) => new Date(value).toISOString(),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-dialog">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";

describe("IntakeEditDialog seed (G-1 §9 Q1)", () => {
  it("seeds the datetime-local input from the event's real takenAt", () => {
    // 2026-03-04T09:30 in local time — the dialog formats to
    // `YYYY-MM-DDTHH:mm` in the user's timezone.
    const taken = new Date(2026, 2, 4, 9, 30).toISOString();
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: taken, skipped: false }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('value="2026-03-04T09:30"');
  });

  it("seeds the skipped switch from a skipped event (no stub default)", () => {
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-2", takenAt: null, skipped: true }}
        onClose={() => {}}
      />,
    );
    // Radix Switch reflects checked state via data-state.
    expect(html).toContain('data-state="checked"');
  });

  it("renders nothing when no event is selected", () => {
    const html = renderToStaticMarkup(
      <IntakeEditDialog medicationId="med-1" event={null} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });
});

describe("IntakeEditDialog guardrails (P0-4)", () => {
  it("caps the datetime-local picker at now via the max attribute", () => {
    const taken = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: taken, skipped: false }}
        onClose={() => {}}
      />,
    );
    // `YYYY-MM-DDTHH:mm` — exact value depends on render time, so pin the
    // attribute presence + shape rather than the instant.
    expect(html).toMatch(/max="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
  });

  it("renders the scheduled-slot reference when the event carries one", () => {
    const slot = new Date(2026, 2, 4, 8, 0).toISOString();
    const taken = new Date(2026, 2, 4, 8, 10).toISOString();
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: taken, skipped: false, scheduledFor: slot }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("medications.detail.intake.edit.scheduledForHint");
    // An on-time take never triggers the far-from-slot warning.
    expect(html).not.toContain(
      "medications.detail.intake.edit.farFromScheduledWarning",
    );
  });

  it("shows the non-blocking far-from-slot hint when takenAt sits >48h from the slot", () => {
    const slot = new Date(2026, 2, 4, 8, 0).toISOString();
    // A month-off typo — exactly the P0-4 production case.
    const taken = new Date(2026, 1, 4, 8, 0).toISOString();
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: taken, skipped: false, scheduledFor: slot }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(
      "medications.detail.intake.edit.farFromScheduledWarning",
    );
  });

  it("no longer renders the note field the API never persisted (LOW-10)", () => {
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: null, skipped: false }}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain("intake-edit-note");
    expect(html).not.toContain("medications.detail.intake.edit.noteLabel");
  });
});
