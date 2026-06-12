import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

// v1.11.2 HIGH-1 — the web Settings list renders one row per WRITABLE id
// (`DASHBOARD_WIDGET_IDS`) MINUS the `IOS_PIN_ONLY_WIDGET_IDS` (writable so
// the iOS pin PUT validates, but with no web render path). The default
// layout still carries all 24 writable widgets; only this subset renders.
const WEB_RENDERABLE_ROW_COUNT =
  DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length;

// Mutable holder so individual tests can inject a layout (e.g. one that
// carries iOS-only ids) into the mocked `useQuery` without re-mocking
// the module. Defaults to the 16-tile web default layout.
const queryState: { layout: DashboardLayout } = {
  layout: DEFAULT_DASHBOARD_LAYOUT,
};

/**
 * v1.4.15 Fix 5 — independent strip-tile + chart toggles.
 *
 * The settings section grew a SECOND switch column for the upper-row
 * tile, distinct from the existing chart switch. SSR smoke tests are
 * sufficient here; full state-mutation testing would require a DOM
 * runtime which the rest of the settings suite doesn't pull in.
 *
 * v1.4.47 W4 — drag-and-drop reorder via @dnd-kit. The SSR markup picks
 * up the new drag handle, the shared describedby hint paragraph, and
 * keeps the legacy arrow buttons + switches. The reorder contract is
 * exercised via the exported `reorderWidgets` helper so we pin the
 * mutation payload shape without a DOM runtime.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.layout, isLoading: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  DashboardLayoutSection,
  reorderWidgets,
} from "../dashboard-layout-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
});

describe("<DashboardLayoutSection> — tile + chart split", () => {
  it("renders both Tile and Chart column headers in English", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Column headers — the v1.4.15 split.
    expect(html).toContain("Tile");
    expect(html).toContain("Chart");
  });

  it("renders both column headers in German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(html).toContain("Kachel");
    expect(html).toContain("Chart");
  });

  it("paints both switch slots per widget", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The two new data-slots distinguish tile vs chart switches in
    // visual-verify and other consumers.
    expect(html).toContain('data-slot="widget-tile-switch"');
    expect(html).toContain('data-slot="widget-chart-switch"');
  });

  it("each widget paints exactly one tile-switch and one chart-switch", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    const chartSwitches = html.match(/data-slot="widget-chart-switch"/g) ?? [];
    // One tile + one chart switch per WEB-renderable widget (the
    // iOS-pin-only ids are filtered out — they have no web render path).
    expect(tileSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    expect(chartSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });
});

/**
 * v1.4.47 W4 — drag-and-drop reorder surface.
 *
 * The audit (v1.4.43 QoL M1) asked for drag-to-reorder while keeping the
 * arrow-button keyboard fallback. Tests pin (a) the visual surface
 * (drag handle + describedby hint), (b) the keyboard fallback survived,
 * (c) the reorder contract — same `widgets[]` shape with `order: 0..n-1`
 * the existing PUT already accepts.
 */
describe("<DashboardLayoutSection> — drag-and-drop reorder", () => {
  it("paints a drag handle for every widget row", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });

  it("each drag handle has an aria-describedby pointing to a shared hint", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Split the markup into per-handle button fragments so we don't need
    // to care about attribute ordering inside the rendered <button>.
    const handleButtons =
      html.match(/<button[^>]*data-slot="widget-drag-handle"[^>]*>/g) ?? [];
    expect(handleButtons).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    // Every handle declares aria-describedby and they all share the
    // same id (one hint paragraph below the list — single source of
    // truth for screen readers).
    const describedByIds = handleButtons.map((button) => {
      const m = button.match(/aria-describedby="([^"]+)"/);
      expect(m).not.toBeNull();
      return m![1];
    });
    const unique = new Set(describedByIds);
    expect(unique.size).toBe(1);
    const hintId = describedByIds[0];
    // The matching hint paragraph is rendered exactly once.
    expect(html).toMatch(new RegExp(`id="${hintId}"`));
  });

  it("keeps the arrow buttons present after the drag handle lands (a11y fallback)", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Move up + Move down translation keys resolve to the English
    // strings — counted once per row.
    const moveUpCount = (html.match(/aria-label="Move up"/g) ?? []).length;
    const moveDownCount = (html.match(/aria-label="Move down"/g) ?? []).length;
    expect(moveUpCount).toBe(WEB_RENDERABLE_ROW_COUNT);
    expect(moveDownCount).toBe(WEB_RENDERABLE_ROW_COUNT);
  });

  it("hint string localises to German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    // v1.4.48 L9 — copy trimmed to ~12 words so screen readers do
    // not spend ~6 s reading the hint on focus. Anchor on the
    // shortened phrase.
    expect(html).toContain("Pfeiltasten Hoch/Runter");
  });
});

describe("reorderWidgets — pure mutation contract", () => {
  // Synthetic small list so the assertions are readable; the helper is
  // shape-only and doesn't care which ids are dashboard widgets.
  const initial = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
    { id: "d", order: 3 },
  ];

  it("moves an item down and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "a", "c");
    expect(out.map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("moves an item up and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "d", "a");
    expect(out.map((w) => w.id)).toEqual(["d", "a", "b", "c"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("no-op when source equals target", () => {
    const out = reorderWidgets(initial, "b", "b");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("no-op when an id is missing — still normalises order", () => {
    const out = reorderWidgets(initial, "missing", "a");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("preserves stable sort by `order` before reordering", () => {
    const shuffled = [
      { id: "c", order: 2 },
      { id: "a", order: 0 },
      { id: "d", order: 3 },
      { id: "b", order: 1 },
    ];
    const out = reorderWidgets(shuffled, "a", "d");
    // Sort first → [a, b, c, d]; move a → d position → [b, c, d, a].
    expect(out.map((w) => w.id)).toEqual(["b", "c", "d", "a"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("returns a fresh array — does not mutate the input", () => {
    const snapshot = JSON.parse(JSON.stringify(initial));
    reorderWidgets(initial, "a", "c");
    expect(initial).toEqual(snapshot);
  });
});

/**
 * v1.7.0 W1 — the stored layout now round-trips the 11 iOS-only widget
 * ids. The web Settings list has no tile/chart surface for them, so the
 * render must SKIP an id with no web component rather than paint an
 * unlabelled row with dead toggles.
 */
describe("<DashboardLayoutSection> — iOS-only id skip (v1.7.0)", () => {
  it("renders only web-known rows when the layout carries iOS-only ids", () => {
    // Inject a layout = the 16 web defaults + the 11 iOS-only ids.
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        ...DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: DEFAULT_DASHBOARD_LAYOUT.widgets.length + i,
        })),
      ],
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);

    // One row (= one tile switch) per WEB-renderable widget — the iOS-only
    // ids (and the iOS-pin-only writable ids) are skipped, not rendered as
    // raw-id rows.
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    expect(tileSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT);

    // No iOS-only raw id leaks into the markup as a row label.
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(html).not.toContain(`>${iosId}<`);
    }
  });

  it("does not crash when the layout is ENTIRELY iOS-only ids", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // No web-known rows → zero switches, but the section still renders.
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    expect(tileSwitches).toHaveLength(0);
    expect(html).toContain("dashboard-layout");
  });
});

/**
 * Dashboard hero (Tagesüberblick) visibility switch — one toggle above
 * the widget list, persisted as `heroVisible` on the layout blob through
 * the SAME PUT mutation the widget rows use (the Save button flushes the
 * draft). SSR smoke assertions + source pins, matching the rest of this
 * suite (no DOM runtime for state mutation).
 */
describe("<DashboardLayoutSection> — hero visibility switch", () => {
  it("renders one hero switch above the widget list", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches = html.match(/data-slot="hero-visible-switch"/g) ?? [];
    expect(switches).toHaveLength(1);
    // Above the list: the hero switch markup precedes the first widget row.
    expect(html.indexOf('data-slot="hero-visible-switch"')).toBeLessThan(
      html.indexOf('data-slot="widget-row"'),
    );
  });

  it("labels the switch with the localised copy + description", () => {
    const de = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(de).toContain("Tagesüberblick");
    expect(de).toContain(
      "Zeigt Score, Tagesfokus und Dosen-Status ganz oben auf dem Dashboard.",
    );
    const en = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(en).toContain("Daily overview");
  });

  it("reflects heroVisible: default layout → checked, false → unchecked", () => {
    const checkedHtml = render(
      <DashboardLayoutSection id="dashboard-layout" />,
    );
    const checked = checkedHtml.match(
      /<button[^>]*data-slot="hero-visible-switch"[^>]*>/,
    );
    expect(checked).not.toBeNull();
    expect(checked![0]).toContain('data-state="checked"');

    queryState.layout = { ...DEFAULT_DASHBOARD_LAYOUT, heroVisible: false };
    const uncheckedHtml = render(
      <DashboardLayoutSection id="dashboard-layout" />,
    );
    const unchecked = uncheckedHtml.match(
      /<button[^>]*data-slot="hero-visible-switch"[^>]*>/,
    );
    expect(unchecked).not.toBeNull();
    expect(unchecked![0]).toContain('data-state="unchecked"');
  });

  it("persists through the existing PUT draft flow (source pins)", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/dashboard-layout-section.tsx",
      ),
      "utf8",
    );
    // The toggle writes the flag onto the layout draft…
    expect(src).toMatch(
      /setDraft\(\{\s*\.\.\.layout,\s*heroVisible:\s*value\s*\}\)/,
    );
    // …which the Save button flushes via the one save mutation
    // (`apiPut("/api/dashboard/widgets", …)`) every other control uses.
    expect(src).toMatch(/onCheckedChange=\{\(v\) => setHeroVisible\(v\)\}/);
    expect(src).toMatch(
      /apiPut<DashboardLayout>\("\/api\/dashboard\/widgets", next\)/,
    );
  });
});

/**
 * v1.11.2 HIGH-1 — the 8 B5 ids are WRITABLE (in DASHBOARD_WIDGET_IDS so the
 * iOS pin PUT validates them) but have NO web render path, so the web
 * Settings list must NOT offer a dead toggle for them.
 */
describe("<DashboardLayoutSection> — iOS-pin-only ids hidden from web (v1.11.2)", () => {
  it("renders one fewer row per iOS-pin-only id than the writable id count", () => {
    // Default layout carries all 24 writable widgets incl. the 8 pin-only.
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    expect(tileSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    // Sanity: WEB_RENDERABLE_ROW_COUNT == writable − pin-only.
    expect(WEB_RENDERABLE_ROW_COUNT).toBe(
      DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length,
    );
  });

  it("does not paint a row whose aria-label matches an iOS-pin-only widget label", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The pin-only ids reuse `measurements.type*` labels that resolve to
    // distinctive English strings; none should appear as a toggle aria-label.
    const pinOnlyLabels: Record<
      (typeof IOS_PIN_ONLY_WIDGET_IDS)[number],
      string
    > = {
      cardioRecovery: "Cardio recovery",
      sixMinuteWalk: "Six-minute walk distance",
      stairAscentSpeed: "Stair ascent speed",
      stairDescentSpeed: "Stair descent speed",
      breathingDisturbances: "Breathing disturbances",
      wristTemperature: "Wrist temperature",
      falls: "Falls",
      walkingSteadiness: "Walking steadiness",
    };
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      // The widget label drives the switch aria-label; if the row were
      // rendered the localised label would show up in the markup.
      expect(html).not.toContain(`${pinOnlyLabels[id]} — `);
    }
  });
});
