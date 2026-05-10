import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachDrawerBody } from "../coach-drawer-body";

/**
 * v1.4.20 phase B4 — Coach drawer mobile rail trays.
 *
 * The drawer hides the history + sources rails on `<lg`. B4 adds two
 * chevron-button triggers along the edges of the message thread that
 * open side-sheets surfacing the same rails. The triggers live on
 * `<CoachDrawerBody>` so the SSR test can pin their `lg:hidden` class
 * + slot markers without rendering the outer Radix `<Sheet>` portal
 * (which is client-only).
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  historyRail: <span>history</span>,
  sourcesRail: <span>sources</span>,
  thread: <span>thread</span>,
  composer: <span>composer</span>,
  onOpenHistoryTray: () => undefined,
  onOpenSourcesTray: () => undefined,
};

describe("<CoachDrawerBody> — mobile rail trays", () => {
  it("renders both tray triggers", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-history-tray-trigger"/);
    expect(html).toMatch(/data-slot="coach-drawer-sources-tray-trigger"/);
  });

  it("hides both triggers on >=lg via the lg:hidden class", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    const historyTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-history-tray-trigger"[^>]*>/,
    );
    expect(historyTrigger).not.toBeNull();
    expect(historyTrigger?.[0]).toContain("lg:hidden");

    const sourcesTrigger = html.match(
      /<button[^>]*data-slot="coach-drawer-sources-tray-trigger"[^>]*>/,
    );
    expect(sourcesTrigger).not.toBeNull();
    expect(sourcesTrigger?.[0]).toContain("lg:hidden");
  });

  it("renders the desktop history + sources rails (visible on >=lg)", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(
      /<aside[^>]*data-slot="coach-drawer-history"[^>]*lg:flex/,
    );
    expect(html).toMatch(
      /<aside[^>]*data-slot="coach-drawer-sources"[^>]*lg:flex/,
    );
  });

  it("renders the message thread + composer slots", () => {
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(/data-slot="coach-drawer-thread"/);
    expect(html).toMatch(/data-slot="coach-drawer-composer"/);
    // Slot content forwarded verbatim.
    expect(html).toContain("thread");
    expect(html).toContain("composer");
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

  it("the thread region wraps the rail triggers in a relative container", () => {
    // The triggers use absolute positioning; the thread region must
    // be `relative` for them to anchor inside it.
    const html = render(<CoachDrawerBody {...baseProps} />);
    expect(html).toMatch(
      /<main[^>]*data-slot="coach-drawer-thread"[^>]*relative/,
    );
  });
});
