/**
 * `<DateField>` contract (v1.21.0).
 *
 * The SSR-only convention (no `@testing-library/react`, `environment: "node"`)
 * means the interactive picker / typed-entry paths can't be driven here — those
 * ride `showPicker()` + change events the static renderer never fires. What the
 * static markup CAN pin is the load-bearing contract:
 *
 *   - the committed VALUE stays ISO `yyyy-MM-dd` on a hidden native date input,
 *     so this is a drop-in for `<DateInput>` and react-hook-form is unchanged;
 *   - the visible overlay paints the value formatted per the preference;
 *   - disabled / min / max / placeholder thread through;
 *   - height + target-size parity classes are present.
 *
 * Under SSR `useDateFormatPreference()` resolves AUTO (no `window`), so the
 * overlay reflects the locale order — de → dd.MM.yyyy, en → MM/dd/yyyy. The
 * per-preference order itself is covered exhaustively in
 * `src/lib/__tests__/date-format.test.ts` against the pure formatter.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { DateField } from "../date-field";

function render(node: React.ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<DateField>", () => {
  it("keeps the ISO value on a hidden native date input", () => {
    const html = render(<DateField id="dob" name="dob" value="2026-02-19" />);
    // The real value lives on a type=date input (the form's source of truth).
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-02-19"/);
    expect(html).toContain('name="dob"');
    // …and it is visually hidden so only the overlay shows.
    expect(html).toMatch(/<input[^>]*type="date"[^>]*class="[^"]*sr-only/);
  });

  it("paints the AUTO-locale display string over the value (en → MM/dd/yyyy)", () => {
    const html = render(<DateField value="2026-02-19" />, "en");
    expect(html).toContain('value="02/19/2026"');
  });

  it("paints the AUTO-locale display string over the value (de → dd.MM.yyyy)", () => {
    const html = render(<DateField value="2026-02-19" />, "de");
    expect(html).toContain('value="19.02.2026"');
  });

  it("renders the placeholder shape when empty", () => {
    const html = render(<DateField value="" placeholder="Pick a date" />);
    expect(html).toContain('placeholder="Pick a date"');
  });

  it("derives a format-shaped placeholder when none is supplied (en → MM/DD/YYYY)", () => {
    const html = render(<DateField value="" />, "en");
    expect(html).toContain('placeholder="MM/DD/YYYY"');
  });

  it("threads disabled, min and max onto the native input", () => {
    const html = render(
      <DateField
        value="2026-02-19"
        disabled
        min="2020-01-01"
        max="2030-12-31"
      />,
    );
    expect(html).toMatch(/<input[^>]*type="date"[^>]*min="2020-01-01"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*max="2030-12-31"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*disabled/);
  });

  it("ships the WCAG target-size + height-parity classes", () => {
    const html = render(<DateField value="2026-02-19" />);
    // Same 44px mobile / 40px sm+ floor as <DateInput>.
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:h-10");
  });

  it("exposes a labelled calendar picker affordance", () => {
    const html = render(<DateField value="2026-02-19" />);
    expect(html).toContain('aria-label="Open date picker"');
  });
});
