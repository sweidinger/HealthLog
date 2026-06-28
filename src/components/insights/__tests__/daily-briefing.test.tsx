import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { DailyBriefing } from "../daily-briefing";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

// The updated-at footer reads the profile timezone via `useAuth`; stub it so the
// SSR render does not reach for a QueryClient the static-markup test omits.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "Europe/Berlin" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * v1.4.20 phase B1 — full-width Daily Briefing card.
 *
 * The card sits below the hero strip on `/insights` and renders the
 * narrative paragraph + 0-5 key-finding rows produced by the AI
 * pipeline. Tests cover: paragraph rendering, finding rows + tones +
 * deltas, locale-aware title, empty state with CTA, loading skeleton,
 * meta slot.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseBriefing: DailyBriefingPayload = {
  paragraph:
    "You're trending well this week. Blood pressure is in target band on 9 of 10 readings, weight is down 2.5 kg over the last 30 days, and your medication compliance streak is now 21 days.",
  keyFindings: [
    {
      tone: "good",
      headline: "Blood pressure entered target",
      detail: "9 of last 10 readings under 130/85.",
      delta: "↓ 4 mmHg",
      sourceWindow: "30d",
      sourceMetric: "bp",
    },
    {
      tone: "watch",
      headline: "Monday-morning systolic spike",
      detail: "+6 mmHg vs other weekdays.",
      delta: "+6 mmHg",
      sourceWindow: "30d",
      sourceMetric: "bp",
    },
    {
      tone: "info",
      headline: "Weight down 30 d",
      detail: "Linear, sustainable rate. BMI now 26.0.",
      delta: null,
      sourceWindow: "30d",
      sourceMetric: "weight",
    },
  ],
};

describe("<DailyBriefing>", () => {
  it("renders the title in English", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing"/);
    expect(html).toContain("Daily Briefing");
  });

  it("renders the title in German", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />, "de");
    expect(html).toContain("Tagesbriefing");
  });

  it("v1.4.27 B1 — does NOT render the leading narrative paragraph", () => {
    // The hero strip subtitle on /insights renders the same
    // `briefing.paragraph` directly above this card, so the card now
    // opens straight on the key-findings list. The paragraph slot is
    // gone from the populated branch; the empty-state branch still
    // owns its CTA copy.
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-paragraph"');
    expect(html).not.toContain(
      "Blood pressure is in target band on 9 of 10 readings",
    );
  });

  it("renders one row per key finding", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    const matches = html.match(/data-slot="daily-briefing-finding"/g) ?? [];
    expect(matches.length).toBe(3);
    expect(html).toContain("Blood pressure entered target");
    expect(html).toContain("Monday-morning systolic spike");
    expect(html).toContain("Weight down 30 d");
  });

  it("renders the delta string when supplied", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing-delta"/);
    expect(html).toContain("↓ 4 mmHg");
    expect(html).toContain("+6 mmHg");
  });

  it("does NOT render a delta badge when delta is null", () => {
    const html = render(
      <DailyBriefing
        briefing={{
          ...baseBriefing,
          keyFindings: [
            {
              ...baseBriefing.keyFindings[2],
            },
          ],
        }}
      />,
    );
    // Only one finding rendered, and it has delta=null.
    const deltas = html.match(/data-slot="daily-briefing-delta"/g) ?? [];
    expect(deltas.length).toBe(0);
  });

  it("uses tone-specific colour classes per finding", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    // Routed through the semantic feedback tokens (AA-safe in light mode);
    // raw `--dracula-*` text primitives have no light-mode override.
    expect(html).toContain("bg-success"); // tone=good bar
    expect(html).toContain("bg-warning"); // tone=watch bar
    expect(html).toContain("bg-info"); // tone=info bar
  });

  it("renders the 'Updated today, <time>' caption when updatedAt is supplied", () => {
    // v1.22 (W6) — the footer now uses `formatUpdatedLabel`: a same-day
    // timestamp reads "Updated today, HH:MM".
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render(
      <DailyBriefing briefing={baseBriefing} updatedAt={fiveMinutesAgo} />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-updated"/);
    expect(html).toContain("Updated today");
  });

  it("does NOT render the updated caption when updatedAt is missing", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-updated"');
  });

  it("renders the keyFindings title separator", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing-findings-title"/);
    expect(html).toContain("Key findings");
  });

  it("hides the keyFindings section when the array is empty", () => {
    // v1.4.27 B1 — the leading paragraph dropped; the card now renders
    // only the header + (when present) the findings list. With both
    // gone the populated branch produces no body content, which the
    // hero strip already covers.
    const html = render(
      <DailyBriefing briefing={{ ...baseBriefing, keyFindings: [] }} />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-findings-title"');
    expect(html).not.toContain('data-slot="daily-briefing-findings"');
    expect(html).not.toContain('data-slot="daily-briefing-paragraph"');
  });

  it("renders the empty state when briefing is null and not loading", () => {
    const html = render(<DailyBriefing briefing={null} />);
    expect(html).toMatch(/data-slot="daily-briefing-empty"/);
    expect(html).toContain("No briefing yet");
  });

  it("renders the empty-state CTA when onRegenerate is supplied", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"/);
    expect(html).toContain("Generate briefing");
  });

  it("hides the empty-state CTA when onRegenerate is not supplied", () => {
    const html = render(<DailyBriefing briefing={null} />);
    expect(html).not.toContain('data-slot="daily-briefing-empty-cta"');
  });

  it("disables the empty-state CTA while regenerating", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} regenerating />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"[^>]*disabled/);
    expect(html).toContain("Regenerating");
  });

  it("renders the shimmer skeleton when loading", () => {
    const html = render(<DailyBriefing briefing={null} loading />);
    expect(html).toMatch(/data-slot="daily-briefing-skeleton"/);
    expect(html).toContain("animate-pulse");
    // Empty state must NOT render while loading.
    expect(html).not.toContain('data-slot="daily-briefing-empty"');
  });

  it("renders the meta slot when supplied", () => {
    const html = render(
      <DailyBriefing
        briefing={baseBriefing}
        metaSlot={<span data-testid="meta-token">meta-content</span>}
      />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-meta-slot"/);
    expect(html).toContain("meta-content");
  });

  it("does NOT render the meta-slot wrapper when metaSlot is missing", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-meta-slot"');
  });

  // v1.15.20 — no-provider state: the regenerate CTA would 422 forever,
  // so the card points at Settings → AI instead.
  it("renders the connect-provider hint with a settings link when noProvider", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} noProvider />,
    );
    expect(html).toContain('data-slot="daily-briefing-no-provider"');
    expect(html).toContain("No AI provider connected");
    expect(html).toMatch(/href="\/settings\/ai"/);
    // The futile regenerate CTA must NOT render in this state.
    expect(html).not.toContain('data-slot="daily-briefing-empty-cta"');
  });

  it("renders the German connect-provider hint under the de locale", () => {
    const html = render(<DailyBriefing briefing={null} noProvider />, "de");
    expect(html).toContain("Kein KI-Anbieter verbunden");
  });

  it("prefers the briefing content over the no-provider hint when both exist", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} noProvider />);
    expect(html).toContain('data-slot="daily-briefing-findings"');
    expect(html).not.toContain('data-slot="daily-briefing-no-provider"');
  });

  // v1.25 — generation-failed affordances. The briefing keeps its last good
  // text; the card adds an honest "couldn't refresh" footer hint on a held
  // briefing and a "couldn't generate — retry" empty state when there is none.
  it("renders the refresh-failed footer hint on a held briefing", () => {
    const html = render(
      <DailyBriefing
        briefing={baseBriefing}
        onRegenerate={() => {}}
        generationFailed
      />,
    );
    expect(html).toContain('data-slot="daily-briefing-refresh-failed"');
    // The rendered apostrophe is HTML-escaped; match the unambiguous tail.
    expect(html).toContain("refresh the briefing");
    expect(html).toContain('data-slot="daily-briefing-refresh-failed-retry"');
  });

  it("does NOT render the refresh-failed hint when generation did not fail", () => {
    const html = render(
      <DailyBriefing briefing={baseBriefing} onRegenerate={() => {}} />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-refresh-failed"');
  });

  it("suppresses the refresh-failed hint when no provider is connected", () => {
    const html = render(
      <DailyBriefing
        briefing={baseBriefing}
        onRegenerate={() => {}}
        generationFailed
        noProviderStale
      />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-refresh-failed"');
    expect(html).toContain('data-slot="daily-briefing-stale-no-provider"');
  });

  it("renders the 'couldn't generate' empty state with a retry CTA when failed and empty", () => {
    const html = render(
      <DailyBriefing
        briefing={null}
        onRegenerate={() => {}}
        generationFailed
      />,
    );
    // The rendered apostrophe is HTML-escaped; match the unambiguous tail.
    expect(html).toContain("generate the briefing");
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"/);
    expect(html).toContain("Retry");
  });
});
