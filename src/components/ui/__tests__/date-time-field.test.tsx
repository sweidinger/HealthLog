/**
 * `<DateTimeField>` contract (v1.25.4).
 *
 * The field now composes a native-calendar `<DateField>` (date part) with the
 * app-controlled `<TimeField>` (time part) so the time picker always follows
 * the user's hour-cycle preference rather than the browser UI language. Like
 * `<DateField>`, the SSR-only convention (`renderToStaticMarkup`,
 * `environment: "node"`) means the interactive picker path can't be driven
 * here. What the static markup pins is the load-bearing contract:
 *
 *   - the committed VALUE stays a local `yyyy-MM-ddTHH:mm` string on a hidden
 *     input carrying `name`, so this is a drop-in for the old field;
 *   - the date overlay paints the date-order preference; the time overlay paints
 *     the hour-cycle preference;
 *   - disabled threads through; min / max gate the native calendar by date part;
 *   - height + target-size parity classes are present on both halves.
 *
 * Under SSR both preferences resolve AUTO (no `window`), so each half follows
 * the locale: de → "31.12.2026" + "14:05" (24h), en → "12/31/2026" + 12h.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { DateTimeField } from "../date-time-field";

function render(node: React.ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<DateTimeField>", () => {
  it("keeps the combined local datetime value on a hidden input carrying name", () => {
    const html = render(
      <DateTimeField id="ts" name="ts" value="2026-12-31T14:05" />,
    );
    expect(html).toMatch(
      /<input[^>]*type="hidden"[^>]*value="2026-12-31T14:05"/,
    );
    expect(html).toContain('name="ts"');
  });

  it("paints the AUTO-locale display (de → dd.MM.yyyy + 24h time)", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />, "de");
    expect(html).toContain('value="31.12.2026"');
    expect(html).toContain('value="14:05"');
  });

  it("paints the AUTO-locale display (en → MM/dd/yyyy + 12h time)", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />, "en");
    expect(html).toContain('value="12/31/2026"');
    // en-US default hour cycle is AM/PM.
    expect(html).toMatch(/value="02:05\s?PM"/);
  });

  it("threads the supplied placeholder onto the date half", () => {
    const html = render(<DateTimeField value="" placeholder="Pick a moment" />);
    expect(html).toContain('placeholder="Pick a moment"');
  });

  it("gates the native calendar by the min/max date part and threads disabled", () => {
    const html = render(
      <DateTimeField
        value="2026-12-31T14:05"
        disabled
        min="2020-01-01T00:00"
        max="2030-12-31T23:59"
      />,
    );
    expect(html).toMatch(/<input[^>]*type="date"[^>]*min="2020-01-01"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*max="2030-12-31"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*disabled/);
  });

  it("ships the WCAG target-size + height-parity classes on both halves", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />);
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:h-10");
  });

  it("exposes both the calendar and the time picker affordances", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />);
    expect(html).toContain('aria-label="Open date picker"');
    expect(html).toContain('aria-label="Open time picker"');
  });
});
