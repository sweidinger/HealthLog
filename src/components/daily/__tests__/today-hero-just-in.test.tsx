/**
 * The Today hero's "just in" chip and the reaction line's lead replacement.
 *
 * Two invariants, both of which have a specific failure this project has
 * already paid for:
 *
 * 1. HYDRATION. The hero is deliberately NOT mount-gated — it paints from the
 *    server-dehydrated digest on the SSR pass because it is the LCP element
 *    (v1.30.9). So anything inside it that differs between the server and the
 *    browser is a React #418 mismatch. A wall-clock time is exactly that: the
 *    server's locale and timezone are not the reader's. The chip therefore
 *    renders its SLOT on both passes and fills the time in only after mount.
 *    These tests render through `renderToStaticMarkup`, which takes the SERVER
 *    snapshot of `useSyncExternalStore` — i.e. precisely the pass that must
 *    carry no formatted time.
 *
 * 2. NO LAYOUT SHIFT. The reaction line REPLACES the lead; it is never a second
 *    paragraph. The hero stays one lead line tall, so nothing below it moves
 *    when the line arrives on a poll.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TodayHero } from "../today-hero";
import type { DailyDigest } from "@/lib/daily/digest";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const ARRIVED_AT = "2026-07-16T05:41:00.000Z";

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    phase: "final",
    sleepPending: false,
    score: { value: 82, band: "green", delta: 3 },
    topSignal: null,
    briefingLead: "Your week is trending steady.",
    line: "Your week is trending steady.",
    worthALook: [],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

/** Any hh:mm clock face — the thing the server must never emit. */
const CLOCK_FACE = /\d{1,2}:\d{2}/;

describe("TodayHero — the just-in chip", () => {
  it("renders no chip when nothing landed", () => {
    const html = render(<TodayHero digest={digest()} />);
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  it("renders the chip slot on the server pass, carrying the kind", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "sleep_night", at: ARRIVED_AT } })}
      />,
    );

    // The slot is present on the SSR pass, so the hydration render — which
    // takes the same server snapshot — produces identical HTML.
    expect(html).toContain('data-slot="today-hero-just-in"');
    expect(html).toContain('data-just-in-kind="sleep_night"');
    expect(html).toContain("Just in");
  });

  it("renders for a bare account when the arrival has no generated line", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          worthALook: [],
          reactionLine: null,
          justIn: { kind: "sleep_night", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-just-in"');
  });

  it("emits NO formatted time and no raw ISO instant on the server pass", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "weight", at: ARRIVED_AT } })}
      />,
    );

    const chip = html.slice(html.indexOf('data-slot="today-hero-just-in"'));
    // The mismatch itself: a wall clock the browser would render differently.
    expect(chip).not.toMatch(CLOCK_FACE);
    // And the raw instant must not leak either — it is machine data, not copy.
    expect(html).not.toContain(ARRIVED_AT);
  });

  it("keeps the chip muted meta — never an accent, never an opacity modifier", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "workout", at: ARRIVED_AT } })}
      />,
    );

    const row = html.slice(
      0,
      html.indexOf('data-slot="today-hero-just-in"') + 400,
    );
    expect(row).toContain("text-muted-foreground");
    expect(row).toContain("text-xs");
    // UI-STANDARDS §text: alpha on muted text drops below AA contrast.
    expect(html).not.toContain("text-muted-foreground/");
    expect(html).not.toContain("text-primary");
  });

  it("shows the chip alongside a still-pending night", () => {
    // Legitimately co-occurring: a weight landed this morning while last
    // night's sleep has not arrived yet.
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).toContain('data-slot="today-hero-just-in"');
  });

  it("localises the chip", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "sleep_night", at: ARRIVED_AT } })}
      />,
      "de",
    );
    expect(html).toContain("Gerade eingetroffen");
    expect(html).not.toContain("Just in");
  });
});

describe("TodayHero — the reaction line replaces the lead", () => {
  const REACTION = "A solid night, deeper than your recent stretch.";

  it("renders the reaction line instead of the briefing lead", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );

    expect(html).toContain(REACTION);
    // The lead it replaced must be GONE, not pushed down into a second block.
    expect(html).not.toContain("Your week is trending steady.");
  });

  it("stays exactly one lead line tall — no second paragraph, no shift", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );

    const leadSlots = html.split('data-slot="today-hero-lead"').length - 1;
    expect(leadSlots).toBe(1);
  });

  it("falls back to the briefing lead when no line was generated", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: null,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );
    expect(html).toContain("Your week is trending steady.");
  });

  it("still renders for an otherwise-bare account when a line exists", () => {
    // The one moment this surface exists for must not be swallowed by the
    // empty-account degrade.
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          worthALook: [],
          reactionLine: REACTION,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain(REACTION);
  });
});
