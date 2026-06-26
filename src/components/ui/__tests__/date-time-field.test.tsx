/**
 * `<DateTimeField>` contract (v1.21.0).
 *
 * Like `<DateField>`, the SSR-only convention (`renderToStaticMarkup`,
 * `environment: "node"`) means the interactive picker path can't be driven
 * here. What the static markup pins is the load-bearing contract:
 *
 *   - the committed VALUE stays a local `yyyy-MM-ddTHH:mm` string on a hidden
 *     native datetime-local input, so this is a drop-in for `<DateTimeInput>`;
 *   - the visible overlay paints the date in the date-order preference and the
 *     time in the hour-cycle preference;
 *   - disabled / min / max / placeholder thread through;
 *   - height + target-size parity classes are present.
 *
 * Under SSR both preferences resolve AUTO (no `window`), so the overlay follows
 * the locale: de → "31.12.2026 14:05" (24h), en → "12/31/2026 02:05 PM".
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
  it("keeps the local datetime value on a hidden native datetime-local input", () => {
    const html = render(
      <DateTimeField id="ts" name="ts" value="2026-12-31T14:05" />,
    );
    expect(html).toMatch(
      /<input[^>]*type="datetime-local"[^>]*value="2026-12-31T14:05"/,
    );
    expect(html).toContain('name="ts"');
    expect(html).toMatch(
      /<input[^>]*type="datetime-local"[^>]*class="[^"]*sr-only/,
    );
  });

  it("paints the AUTO-locale display (de → dd.MM.yyyy + 24h)", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />, "de");
    expect(html).toContain('value="31.12.2026 14:05"');
  });

  it("paints the AUTO-locale display (en → MM/dd/yyyy + 12h)", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />, "en");
    // en-US default hour cycle is AM/PM.
    expect(html).toMatch(/value="12\/31\/2026 02:05\s?PM"/);
  });

  it("renders the supplied placeholder when empty", () => {
    const html = render(<DateTimeField value="" placeholder="Pick a moment" />);
    expect(html).toContain('placeholder="Pick a moment"');
  });

  it("derives a format-shaped placeholder when none is supplied (en)", () => {
    const html = render(<DateTimeField value="" />, "en");
    expect(html).toContain('placeholder="MM/DD/YYYY --:--"');
  });

  it("threads disabled, min and max onto the native input", () => {
    const html = render(
      <DateTimeField
        value="2026-12-31T14:05"
        disabled
        min="2020-01-01T00:00"
        max="2030-12-31T23:59"
      />,
    );
    expect(html).toMatch(
      /<input[^>]*type="datetime-local"[^>]*min="2020-01-01T00:00"/,
    );
    expect(html).toMatch(
      /<input[^>]*type="datetime-local"[^>]*max="2030-12-31T23:59"/,
    );
    expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*disabled/);
  });

  it("ships the WCAG target-size + height-parity classes", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />);
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:h-10");
  });

  it("exposes a labelled calendar picker affordance", () => {
    const html = render(<DateTimeField value="2026-12-31T14:05" />);
    expect(html).toContain('aria-label="Open date picker"');
  });
});
