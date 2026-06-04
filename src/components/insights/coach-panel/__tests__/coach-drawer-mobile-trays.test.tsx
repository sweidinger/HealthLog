import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachDrawerBody } from "../coach-drawer-body";

/**
 * v1.4.20 phase B4 — Coach drawer mobile rail trays.
 *
 * Two chevron-button triggers along the thread sub-header open
 * side-sheets surfacing the history + sources rails.
 *
 * v1.12.0 — the conversation history is no longer an inline column on
 * any viewport. The "Conversations" trigger is the only entry to the
 * history rail and is therefore visible at every breakpoint; the
 * sources rail stays inline at xl+ so its trigger keeps `xl:hidden`.
 * The clinical-decisions disclaimer renders once, directly above the
 * composer.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  sourcesRail: <span>sources</span>,
  thread: <span>thread</span>,
  composer: <span>composer</span>,
  disclaimer: <span>disclaimer</span>,
  onOpenHistoryTray: () => undefined,
  onOpenSourcesTray: () => undefined,
};

describe("<CoachDrawerBody> — mobile rail trays", () => {
  it("renders both tray triggers", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-history-tray-trigger"/);
    expect(html).toMatch(/data-slot="coach-drawer-sources-tray-trigger"/);
  });

  it("keeps the history trigger on every breakpoint and hides the sources trigger on >=xl", () => {
    // v1.12.0 — the history rail is tray-only now, so the
    // "Conversations" toggle is always visible (no `lg:hidden`) and
    // the strip wrapper no longer carries `xl:hidden`. The sources
    // trigger keeps `xl:hidden` because the sources rail is inline at
    // xl+.
    const html = render(<CoachDrawerBody {...baseProps} />);
    const strip = html.match(
      /<div[^>]*data-slot="coach-drawer-rail-tray-strip"[^>]*>/,
    );
    expect(strip?.[0]).not.toContain("xl:hidden");

    const historyTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>/,
    );
    expect(historyTrigger).not.toBeNull();
    expect(historyTrigger?.[0]).not.toContain("lg:hidden");

    const sourcesTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-sources-tray-trigger"[^>]*>/,
    );
    expect(sourcesTrigger?.[0]).toContain("xl:hidden");
  });

  it("no longer mounts an inline history column; sources rail stays inline at xl+", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).not.toContain('data-slot="coach-drawer-history"');
    expect(html).toMatch(
      /<aside[^>]*data-slot="coach-drawer-sources"[^>]*xl:flex/,
    );
  });

  it("renders the message thread + composer slots and the disclaimer above the composer", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-thread"/);
    expect(html).toMatch(/data-slot="coach-drawer-composer"/);
    // Slot content forwarded verbatim.
    expect(html).toContain("thread");
    expect(html).toContain("composer");
    // The disclaimer slot renders inside the composer container, before
    // the composer itself.
    expect(html).toContain("disclaimer");
    const composerBlock = html.match(
      /data-slot="coach-drawer-composer"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(composerBlock?.[1]).toContain("disclaimer");
    const disclaimerIdx = html.indexOf("disclaimer");
    const composerIdx = html.lastIndexOf("composer");
    expect(disclaimerIdx).toBeLessThan(composerIdx);
  });

  it("uses chevron-style trigger labels — History on the left, Sources on the right", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    const historyTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(historyTrigger).not.toBeNull();
    expect(historyTrigger?.[0]).toContain("Conversations");

    const sourcesTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-sources-tray-trigger"[^>]*>[\s\S]*?<\/button>/,
    );
    expect(sourcesTrigger).not.toBeNull();
    expect(sourcesTrigger?.[0]).toContain("What I can see");
  });

  it("renders the German trigger labels in the de locale", () => {
    const html = render(<CoachDrawerBody {...baseProps} />, "de");
    expect(html).toContain("Unterhaltungen");
    expect(html).toContain("Worauf ich zugreife");
  });

  it("renders the rail triggers in a sub-header strip above the thread", () => {
    // v1.4.27 R3d MB2 — the triggers were lifted out of the absolute
    // overlay into a sub-header strip so the chevrons sit at a 44 px
    // tap target and never overlay the first message bubble. The
    // strip lives above the thread within the centre column.
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-rail-tray-strip"/);
    const trigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>/,
    );
    expect(trigger?.[0]).toContain("min-h-11");
  });
});
