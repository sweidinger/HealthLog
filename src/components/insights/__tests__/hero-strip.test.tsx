import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { HeroStrip } from "../hero-strip";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * v1.4.20 phase B1 — Insights hero strip.
 *
 * Replaces v1.4.16 `<InsightsPageHero>`. Pinning the slots so future
 * polish can't silently drop the greeting / subtitle / action row /
 * suggested-prompt strip.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const sampleBriefing: DailyBriefingPayload = {
  paragraph:
    "You're trending well this week. BP is in target band on 9 of 10 readings.",
  keyFindings: [],
};

// `getHours()` reads from the local representation. Force a known
// local hour by constructing from a local-time fields tuple.
const morningLocal = new Date(2026, 4, 10, 9, 0, 0); // May 10, 09:00 local
const afternoonLocal = new Date(2026, 4, 10, 14, 0, 0); // May 10, 14:00 local
const eveningLocal = new Date(2026, 4, 10, 20, 0, 0); // May 10, 20:00 local

describe("<HeroStrip>", () => {
  it("renders the slot wrapper + Dracula gradient utility", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip"/);
    expect(html).toContain("hero-gradient");
    expect(html).toContain("glow-purple");
  });

  it("renders the morning greeting in English", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-greeting"/);
    expect(html).toContain("Good morning");
  });

  it("renders the morning greeting in German", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} />,
      "de",
    );
    expect(html).toContain("Guten Morgen");
  });

  it("renders the afternoon greeting in English at 14:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={afternoonLocal} />);
    expect(html).toContain("Good afternoon");
  });

  it("renders the evening greeting in English at 20:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={eveningLocal} />);
    expect(html).toContain("Good evening");
  });

  it("appends the user name to the greeting when supplied", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} userName="Marc" />,
    );
    expect(html).toContain("Good morning, Marc");
  });

  it("does NOT append a comma when userName is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    // Greeting renders without trailing comma + name.
    expect(html).not.toMatch(/Good morning,\s*</);
  });

  it("uses the briefing paragraph as the subtitle when one is supplied", () => {
    const html = render(
      <HeroStrip briefing={sampleBriefing} now={morningLocal} />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-subtitle"/);
    expect(html).toContain(
      "You&#x27;re trending well this week. BP is in target band on 9 of 10 readings.",
    );
  });

  it("falls back to the heroFallbackSubtitle when briefing is null", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toContain(
      "A daily read of your trends, drawn straight from the numbers you&#x27;ve logged.",
    );
  });

  it("renders the personal-baseline meta line", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-baseline"/);
    expect(html).toContain("Based on your last 90 days");
  });

  it("renders the generated-time caption when updatedAt is supplied", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render(
      <HeroStrip
        briefing={null}
        updatedAt={fiveMinutesAgo}
        now={morningLocal}
      />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-generated"/);
    expect(html).toContain("Generated");
  });

  it("does NOT render the generated caption when updatedAt is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-generated"');
  });

  // ── Action row ─────────────────────────────────────────────────────
  it("renders the weekly-report action button as disabled with a 'Coming soon' title", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(
      /data-slot="insights-hero-strip-action-weekly-report"[^>]*disabled[^>]*title="Coming soon"/,
    );
  });

  it("renders the ask-the-coach action button as disabled with a 'Coming soon' title", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(
      /data-slot="insights-hero-strip-action-coach"[^>]*disabled[^>]*title="Coming soon"/,
    );
  });

  it("renders the regenerate button when onRegenerate is supplied", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} onRegenerate={() => {}} />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-action-rerun"/);
    expect(html).toContain("Re-run analysis");
  });

  it("hides the regenerate button when no handler is supplied", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-rerun"');
  });

  it("disables the regenerate button while regenerating", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        onRegenerate={() => {}}
        regenerating
      />,
    );
    expect(html).toMatch(
      /data-slot="insights-hero-strip-action-rerun"[^>]*disabled/,
    );
    expect(html).toContain("Regenerating");
  });

  // ── Suggested prompts strip ────────────────────────────────────────
  it("mounts the SuggestedPrompts strip below the action band", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-prompts"/);
    expect(html).toMatch(/data-slot="insights-suggested-prompts"/);
    expect(html).toContain("Try asking");
    expect(html).toContain("Why was BP higher on Monday?");
  });

  it("forwards onPickPrompt down to the prompt strip without throwing", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        onPickPrompt={() => {}}
      />,
    );
    // The chips render verbatim; SSR doesn't run click handlers.
    expect(html).toMatch(/data-slot="insights-suggested-prompts-chip"/);
  });

  // ── Misc ───────────────────────────────────────────────────────────
  it("supports the German locale fallback subtitle", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} />,
      "de",
    );
    expect(html).toContain("Täglicher Blick auf deine Trends");
  });

  it("uses the now override deterministically (smoke for greeting-bucket logic)", () => {
    // Five different hours map to four different greeting buckets:
    // 09:00 → morning, 14:00 → afternoon, 20:00 → evening, 02:00 → night.
    const earlyMorning = new Date(2026, 4, 10, 2, 0, 0);
    const html = render(<HeroStrip briefing={null} now={earlyMorning} />);
    // Night maps to "Good evening" in EN per the resolver mapping.
    expect(html).toContain("Good evening");
    // Sanity: midnight-bucket sample is NOT "Good morning".
    expect(html).not.toContain("Good morning");
  });

  it("uses the morning bucket at noon-1 (11:59 boundary)", () => {
    const justBeforeNoon = new Date(2026, 4, 10, 11, 59, 0);
    const html = render(<HeroStrip briefing={null} now={justBeforeNoon} />);
    expect(html).toContain("Good morning");
  });
});
