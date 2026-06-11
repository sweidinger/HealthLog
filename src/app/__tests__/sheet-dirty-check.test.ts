/**
 * v1.11.5 — `sheetBodyHasUnsavedInput` dirty-check coverage.
 *
 * The quick-entry sheets confirm-on-dismiss only when the body holds unsaved
 * input. The original walk read `input` / `textarea` only, so a user who
 * changed just the mood `role="radio"` selector or opened a Radix Select
 * (type / medication) could lose the change on a backdrop dismiss with no
 * confirm. These cases lock the extended detection in — and pin the
 * over-trigger guard so a pristine sheet (no radio chosen, every Select on its
 * default and closed) still reads clean.
 *
 * The repo runs vitest in the Node environment (no jsdom / happy-dom). The
 * function only ever touches `document.querySelector` once (the sheet body) and
 * then `body.querySelectorAll` / `body.querySelector` against three fixed
 * selectors, so we drive it with a hand-rolled fake `document` that answers
 * exactly those selectors — no DOM engine, matching the repo's node-only test
 * convention (cf. the SSR-string tests elsewhere).
 */
import { afterEach, describe, expect, it } from "vitest";
import { sheetBodyHasUnsavedInput } from "@/components/dashboard/quick-entry-sheets";

const BODY_SELECTOR = '[data-slot="responsive-sheet-body"]';
const MOOD_RADIO_SELECTOR = '[role="radio"][aria-checked="true"]';
const OPEN_SELECT_SELECTOR = '[role="combobox"][data-state="open"]';

interface FakeField {
  type: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  defaultChecked?: boolean;
}

interface SheetFixture {
  fields?: FakeField[];
  moodRadioSelected?: boolean;
  openSelect?: boolean;
}

/** Install a fake `document` whose queries answer the given fixture. */
function installFakeDocument(fixture: SheetFixture | null): void {
  const body = fixture
    ? {
        querySelectorAll: (sel: string) =>
          sel === "input, textarea" ? (fixture.fields ?? []) : [],
        querySelector: (sel: string) => {
          if (sel === MOOD_RADIO_SELECTOR)
            return fixture.moodRadioSelected ? {} : null;
          if (sel === OPEN_SELECT_SELECTOR)
            return fixture.openSelect ? {} : null;
          return null;
        },
      }
    : null;

  (globalThis as { document?: unknown }).document = {
    querySelector: (sel: string) => (sel === BODY_SELECTOR ? body : null),
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("sheetBodyHasUnsavedInput — mood radio", () => {
  it("is clean when no mood radio is selected (pristine)", () => {
    installFakeDocument({ moodRadioSelected: false });
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("is dirty when a mood radio is selected", () => {
    installFakeDocument({ moodRadioSelected: true });
    expect(sheetBodyHasUnsavedInput()).toBe(true);
  });
});

describe("sheetBodyHasUnsavedInput — Radix Select", () => {
  it("is clean for a closed Select on its default value (no over-trigger)", () => {
    // A measurement-type / medication Select mounts with a non-placeholder
    // DEFAULT and is closed — a pristine sheet must NOT prompt the confirm.
    installFakeDocument({ openSelect: false });
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("is dirty while a Select dropdown is open (mid-interaction)", () => {
    installFakeDocument({ openSelect: true });
    expect(sheetBodyHasUnsavedInput()).toBe(true);
  });
});

describe("sheetBodyHasUnsavedInput — text fields still honoured", () => {
  it("is clean for an empty pristine sheet", () => {
    installFakeDocument({
      fields: [
        { type: "text", value: "" },
        { type: "textarea", value: "" },
        { type: "datetime-local", value: "2026-06-04T08:00" },
      ],
    });
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("is dirty when a text input carries a value", () => {
    installFakeDocument({ fields: [{ type: "text", value: "75.5" }] });
    expect(sheetBodyHasUnsavedInput()).toBe(true);
  });

  it("ignores a prefilled date/time picker (v1.11.4 H1)", () => {
    installFakeDocument({
      fields: [{ type: "datetime-local", value: "2026-06-04T08:00" }],
    });
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("ignores a disabled field carrying a value", () => {
    installFakeDocument({
      fields: [{ type: "text", value: "ignored", disabled: true }],
    });
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("is dirty for a native checkbox toggled off its default", () => {
    installFakeDocument({
      fields: [{ type: "checkbox", checked: true, defaultChecked: false }],
    });
    expect(sheetBodyHasUnsavedInput()).toBe(true);
  });
});

describe("sheetBodyHasUnsavedInput — no sheet body", () => {
  it("is clean when no sheet body is mounted", () => {
    installFakeDocument(null);
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });

  it("is clean when document is undefined (SSR)", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(sheetBodyHasUnsavedInput()).toBe(false);
  });
});
