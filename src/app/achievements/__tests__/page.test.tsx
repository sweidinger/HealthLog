import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AchievementProgress } from "@/lib/gamification/achievements";

/**
 * v1.4.15 phase-B4 — /achievements page contract.
 *
 * Two surfaces under test:
 *
 *   1. `groupByCategory` — pure helper, no provider needed. Locked items
 *      go below unlocked ones, and inside locked-items the closest-to-
 *      unlock sorts first so the user always sees their immediate next
 *      goal at the top of each category.
 *   2. The page render itself — locked entries paint the muted card with
 *      a "Locked" badge + criterion hint + progress bar, unlocked ones
 *      paint the highlighted variant with the "Completed on …" footer.
 *      Both share `<AchievementCard>`; the regression we're guarding
 *      against is "page silently dropped locked entries" which is what
 *      shipped pre-v1.4.15.
 *
 * The page uses TanStack Query under the hood — we mock it via a small
 * `useQuery` shim so the SSR test renders the loaded state directly,
 * matching the `onboarding` page's existing test pattern.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", username: "test", role: "USER" },
  }),
}));

const mockData = {
  summary: {
    unlockedCount: 1,
    totalCount: 3,
    earnedPoints: 8,
    totalPoints: 100,
    completionPercent: 33,
    nextAchievement: null,
  },
  achievements: [
    {
      id: "intake-total-1",
      metric: "totalTakenIntakes",
      category: "medication",
      titleKey: "achievements.badges.intakeTotal1.title",
      descriptionKey: "achievements.badges.intakeTotal1.description",
      icon: "Pill",
      format: "count",
      target: 1,
      current: 1,
      points: 8,
      unlocked: true,
      progressPercent: 100,
      completedAt: "2026-04-15T12:00:00.000Z",
    },
    {
      id: "intake-total-10",
      metric: "totalTakenIntakes",
      category: "medication",
      titleKey: "achievements.badges.intakeTotal10.title",
      descriptionKey: "achievements.badges.intakeTotal10.description",
      icon: "Pill",
      format: "count",
      target: 10,
      current: 4,
      points: 24,
      unlocked: false,
      progressPercent: 40,
      completedAt: null,
    },
    {
      id: "passkey-created-1",
      metric: "passkeyCreatedCount",
      category: "security",
      titleKey: "achievements.badges.passkeyCreated1.title",
      descriptionKey: "achievements.badges.passkeyCreated1.description",
      icon: "KeyRound",
      format: "count",
      target: 1,
      current: 0,
      points: 40,
      unlocked: false,
      progressPercent: 0,
      completedAt: null,
    },
  ] satisfies AchievementProgress[],
  metrics: {
    totalTakenIntakes: 1,
    overIntakeCount: 0,
    skippedIntakeCount: 0,
    bmiGreenStreak: 0,
    bpGreenStreak: 0,
    pulseGreenStreak: 0,
    onTimePerfectDayStreak: 0,
    compliance80DayStreak: 0,
    passkeyCreatedCount: 0,
    passkeyLoginCount: 0,
    passwordLoginCount: 0,
    loginDayStreak: 0,
    bugReportCount: 0,
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockData, isLoading: false }),
}));

import AchievementsPage, { groupByCategory } from "../page";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AchievementsPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("groupByCategory", () => {
  it("buckets achievements by category and orders unlocked first", () => {
    const grouped = groupByCategory(mockData.achievements);
    expect(grouped.map((g) => g.category)).toEqual(["medication", "security"]);

    const medication = grouped.find((g) => g.category === "medication");
    expect(medication?.items.map((i) => i.id)).toEqual([
      "intake-total-1",
      "intake-total-10",
    ]);
  });

  it("inside the locked subset, sorts closest-to-unlock first", () => {
    const grouped = groupByCategory([
      {
        ...mockData.achievements[1], // medication, 40%
      },
      {
        ...mockData.achievements[2], // security, 0% — different category
      },
      {
        ...mockData.achievements[1],
        id: "intake-total-50",
        progressPercent: 5,
      },
    ]);
    const medication = grouped.find((g) => g.category === "medication");
    expect(medication?.items.map((i) => i.progressPercent)).toEqual([40, 5]);
  });
});

describe("<AchievementsPage>", () => {
  it("renders an unlocked card with the completed-on footer", () => {
    const html = render();
    expect(html).toContain("First intake");
    // Unlocked badge text
    expect(html).toContain("Completed on");
    // Unlocked styling marker — the unlocked variant uses the primary
    // gradient background; the locked variant uses opacity-70.
    expect(html).toContain("achievement-card-unlocked");
  });

  it("renders locked entries grayed out with a criterion hint and progress", () => {
    const html = render();
    // Locked entry must still appear — pre-v1.4.15 the page silently
    // dropped locked entries, which is what this guard prevents.
    expect(html).toContain("achievement-card-locked");
    expect(html).toContain("Intake starter"); // intake-total-10 title
    // "Locked" badge label
    expect(html).toContain("Locked");
    // Criterion hint "{current} / {target}" — for intake-total-10 the
    // mock has current=4 / target=10. Using the formatted version
    // (English uses the bare number) so the assertion is precise.
    expect(html).toContain("4 / 10");
  });

  it("groups by category with localized headings and counts", () => {
    const html = render();
    expect(html).toContain("Medication");
    expect(html).toContain("Account &amp; security");
    // Category counts: medication 1/2, security 0/1
    expect(html).toContain("1 / 2");
    expect(html).toContain("0 / 1");
  });

  it("renders the German category headings when locale is de", () => {
    const html = render("de");
    expect(html).toContain("Medikation");
    expect(html).toContain("Konto &amp; Sicherheit");
    expect(html).toContain("Gesperrt"); // German "Locked"
  });
});
