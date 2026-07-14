/**
 * v1.28 — `<NutrientIntakeCard>` render contract.
 *
 * The read-only Settings → Sources list for the opt-in `nutrients`
 * module: renders NOTHING while the module is off (the Modules hub is
 * the consent surface), and a flat name / latest-total / days-count
 * list when it is on. Test strategy mirrors `modules-section.test.tsx`:
 * mock `@tanstack/react-query` + `useAuth`, render under SSR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";

interface QueryState {
  data?: unknown;
  isLoading: boolean;
}
let queryState: QueryState = { data: undefined, isLoading: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));

const authSpy = vi.fn<() => { user: AuthUser | null }>();
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

import { NutrientIntakeCard } from "../nutrient-intake-card";

function user(modules: Record<string, boolean>): AuthUser {
  return { id: "user-1", modules } as unknown as AuthUser;
}

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <NutrientIntakeCard />
    </I18nProvider>,
  );
}

beforeEach(() => {
  queryState = { data: undefined, isLoading: false };
  authSpy.mockReturnValue({ user: user({ nutrients: true }) });
});

describe("<NutrientIntakeCard>", () => {
  it("renders nothing while the nutrients module is off", () => {
    authSpy.mockReturnValue({ user: user({ nutrients: false }) });
    expect(render()).toBe("");

    authSpy.mockReturnValue({ user: user({}) });
    expect(render()).toBe("");
  });

  it("renders the synced list with name, latest total (µg rendered), and day count", () => {
    queryState = {
      isLoading: false,
      data: {
        windowDays: 14,
        nutrients: [
          {
            nutrient: "vitamin_d",
            unit: "ug",
            latestDay: "2026-07-13",
            latestAmount: 22.5,
            daysWithData: 5,
          },
          {
            nutrient: "caffeine",
            unit: "mg",
            latestDay: "2026-07-13",
            latestAmount: 310,
            daysWithData: 14,
          },
        ],
      },
    };
    const html = render();
    expect(html).toContain('data-slot="nutrient-intake-card"');
    expect(html).toContain("Vitamin D");
    expect(html).toContain("Caffeine");
    // Wire `ug` renders as µg; the day key renders verbatim.
    expect(html).toContain("µg");
    expect(html).toContain("2026-07-13");
    const rows = html.match(/data-slot="nutrient-intake-row"/g) ?? [];
    expect(rows).toHaveLength(2);
    // Read-only surface: the only interactive element is the modules link.
    expect(html).toContain('data-slot="nutrient-intake-modules-link"');
    expect(html).not.toContain("<button");
  });

  it("renders the empty state when the module is on but nothing has synced", () => {
    queryState = {
      isLoading: false,
      data: { windowDays: 14, nutrients: [] },
    };
    const html = render();
    expect(html).toContain("No nutrient data has been synced yet.");
  });
});
