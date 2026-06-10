import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { FilterBar, FilterBarDateRange, FilterBarSelect } from "../filter-bar";

/**
 * v1.16.1 — unified filter rail. SSR-markup guards for the shared
 * grammar: pill = trigger + active chip in one element, reset only
 * while filtered, count slot, per-pill clear button with a translated
 * aria-label.
 */

const options = [
  { value: "WEIGHT", label: "Weight" },
  { value: "PULSE", label: "Pulse" },
];

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("FilterBarSelect", () => {
  it("inactive: shows only the dimension name, no clear button", () => {
    const html = render(
      <FilterBar isFiltered={false} onReset={() => {}}>
        <FilterBarSelect
          label="Type"
          value="ALL"
          onValueChange={() => {}}
          allLabel="All types"
          options={options}
        />
      </FilterBar>,
    );
    expect(html).toContain('data-slot="filter-bar-pill"');
    expect(html).toContain('data-active="false"');
    expect(html).toContain("Type");
    expect(html).not.toContain("Clear filter");
  });

  it("active: shows `label: value`, active styling and a labelled clear button", () => {
    const html = render(
      <FilterBar isFiltered onReset={() => {}}>
        <FilterBarSelect
          label="Type"
          value="WEIGHT"
          onValueChange={() => {}}
          allLabel="All types"
          options={options}
        />
      </FilterBar>,
    );
    expect(html).toContain('data-active="true"');
    expect(html).toContain("Weight");
    expect(html).toContain('aria-label="Clear filter: Type"');
  });
});

describe("FilterBarDateRange", () => {
  it("inactive: pill shows the dimension name only", () => {
    const html = render(
      <FilterBar isFiltered={false} onReset={() => {}}>
        <FilterBarDateRange
          label="Date range"
          from=""
          to=""
          onFromChange={() => {}}
          onToChange={() => {}}
          idPrefix="probe"
        />
      </FilterBar>,
    );
    expect(html).toContain('data-active="false"');
    expect(html).toContain("Date range");
  });

  it("active: pill shows the formatted bounds and a clear button", () => {
    const html = render(
      <FilterBar isFiltered onReset={() => {}}>
        <FilterBarDateRange
          label="Date range"
          from="2026-05-12"
          to="2026-06-10"
          onFromChange={() => {}}
          onToChange={() => {}}
          idPrefix="probe"
        />
      </FilterBar>,
    );
    expect(html).toContain('data-active="true"');
    // en dateShort: "05/12" / "06/10" — assert both day fragments are in.
    expect(html).toMatch(/05\/12/);
    expect(html).toMatch(/06\/10/);
    expect(html).toContain('aria-label="Clear filter: Date range"');
  });
});

describe("FilterBar shell", () => {
  it("shows the reset action only while filtered", () => {
    const inactive = render(
      <FilterBar isFiltered={false} onReset={() => {}}>
        <span />
      </FilterBar>,
    );
    const active = render(
      <FilterBar isFiltered onReset={() => {}}>
        <span />
      </FilterBar>,
    );
    expect(inactive).not.toContain("Reset");
    expect(active).toContain("Reset");
  });

  it("renders the result count slot", () => {
    const html = render(
      <FilterBar isFiltered={false} onReset={() => {}} count="42 readings">
        <span />
      </FilterBar>,
    );
    expect(html).toContain("42 readings");
    expect(html).toContain("tabular-nums");
  });

  it("localises reset + clear labels in German", () => {
    const html = render(
      <FilterBar isFiltered onReset={() => {}}>
        <FilterBarSelect
          label="Quelle"
          value="MANUAL"
          onValueChange={() => {}}
          allLabel="Alle Quellen"
          options={[{ value: "MANUAL", label: "Manuell" }]}
        />
      </FilterBar>,
      "de",
    );
    expect(html).toContain("Zurücksetzen");
    expect(html).toContain('aria-label="Filter entfernen: Quelle"');
  });
});
