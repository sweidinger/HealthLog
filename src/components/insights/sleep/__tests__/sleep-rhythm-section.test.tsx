import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SleepRhythmDto } from "../use-sleep-rhythm";

/**
 * v1.17.0 — sleep-rhythm SECTION states.
 *
 * The cards' own partial/learning copy is covered in `sleep-rhythm-cards`;
 * this file pins the section wrapper's three states, mirroring the glucose
 * clinical panel's treatment:
 *   - a query error renders a quiet inline notice, NOT an endless skeleton
 *   - loading (and settled-but-undefined) shows the skeletons
 *   - a settled DTO renders both cards
 * `useAuth` + `useSleepRhythm` are mocked so each branch is deterministic.
 */

const authMock = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authMock(),
}));

const rhythmMock = vi.fn();
vi.mock("../use-sleep-rhythm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-sleep-rhythm")>();
  return { ...actual, useSleepRhythm: () => rhythmMock() };
});

// Import after the mocks are registered.
const { SleepRhythmSection } = await import("../sleep-rhythm-section");

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const READY_DTO: SleepRhythmDto = {
  sleepDebt: {
    state: "ready",
    debtMinutes: 600,
    needMinutes: 420,
    nightsCounted: 10,
    windowNights: 14,
    nightsUntilReady: 0,
  },
  chronotype: {
    state: "ready",
    msfMinutes: 4 * 60 + 30,
    msfScMinutes: 4 * 60,
    band: "intermediate",
    socialJetlagMinutes: 75,
    freeNightsCounted: 6,
    workNightsCounted: 14,
    freeNightsUntilReady: 0,
  },
};

beforeEach(() => {
  authMock.mockReturnValue({ isAuthenticated: true });
  rhythmMock.mockReset();
});

describe("<SleepRhythmSection>", () => {
  it("renders the quiet inline notice on a query error, not an infinite skeleton", () => {
    rhythmMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    const html = render(<SleepRhythmSection enabled />);
    expect(html).toContain('data-slot="sleep-rhythm-error"');
    expect(html).toContain("Your sleep rhythm");
    // No skeletons while errored.
    expect(html).not.toContain('data-slot="sleep-rhythm-loading"');
  });

  it("shows the skeletons while loading", () => {
    rhythmMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    const html = render(<SleepRhythmSection enabled />);
    expect(html).toContain('data-slot="sleep-rhythm-loading"');
    expect(html).not.toContain('data-slot="sleep-rhythm-error"');
  });

  it("renders both cards on a settled DTO with the standard Card rhythm", () => {
    rhythmMock.mockReturnValue({
      data: READY_DTO,
      isLoading: false,
      isError: false,
    });
    const html = render(<SleepRhythmSection enabled />);
    expect(html).toContain("Intermediate type");
    expect(html).toContain("10h 0m short");
    // The cards inherit the house Card rhythm (gap-4 py-4 md:gap-6 md:py-6) —
    // the old compact override must NOT reappear.
    expect(html).not.toContain("gap-2 py-4 md:gap-2 md:py-4");
    expect(html).toContain("md:py-6");
  });

  it("places the two cards side by side when both carry settled data", () => {
    rhythmMock.mockReturnValue({
      data: READY_DTO,
      isLoading: false,
      isError: false,
    });
    const html = render(<SleepRhythmSection enabled />);
    // Two-up on large screens, single column below.
    expect(html).toContain("lg:grid-cols-2");
  });

  it("keeps a lone data-bearing card full width when the other is still learning", () => {
    rhythmMock.mockReturnValue({
      data: {
        ...READY_DTO,
        // Sleep-debt settled, chronotype still learning → no two-up grid.
        chronotype: {
          state: "learning",
          msfMinutes: null,
          msfScMinutes: null,
          band: null,
          socialJetlagMinutes: null,
          freeNightsCounted: 2,
          workNightsCounted: 5,
          freeNightsUntilReady: 4,
        },
      } satisfies SleepRhythmDto,
      isLoading: false,
      isError: false,
    });
    const html = render(<SleepRhythmSection enabled />);
    expect(html).toContain("grid-cols-1");
    expect(html).not.toContain("lg:grid-cols-2");
  });

  it("renders nothing when disabled", () => {
    rhythmMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
    const html = render(<SleepRhythmSection enabled={false} />);
    expect(html).toBe("");
  });
});
