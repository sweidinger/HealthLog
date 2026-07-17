import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { PriorityCard } from "../priority-card";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
  type PriorityItemKind,
} from "@/lib/daily/priority-item";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function item(
  over: Partial<PriorityItem> & { kind: PriorityItemKind },
): PriorityItem {
  return {
    title: "Something to look at",
    actions: [
      {
        labelKey: "daily.action.reconnect",
        intent: "sync.reconnect",
        href: "/settings/integrations",
      },
    ],
    ...over,
  };
}

describe("<PriorityCard>", () => {
  it("renders every kind of the discriminated union without throwing", () => {
    for (const kind of PRIORITY_ITEM_KINDS) {
      const html = render(<PriorityCard item={item({ kind })} />);
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain("Something to look at");
    }
  });

  it("renders the grounded body one-liner", () => {
    const html = render(
      <PriorityCard
        item={item({ kind: "dose_window", body: "Ramipril is due today." })}
      />,
    );
    expect(html).toContain("Ramipril is due today.");
  });

  it("applies a semantic status wash (meaning, not decoration)", () => {
    const warn = render(
      <PriorityCard item={item({ kind: "sync_issue", status: "warning" })} />,
    );
    expect(warn).toContain("bg-warning/10");
    const info = render(
      <PriorityCard item={item({ kind: "preventive_care", status: "info" })} />,
    );
    expect(info).toContain("bg-info/10");
  });

  it("carries the metric-family accent for metric-flavoured kinds only", () => {
    const tension = render(
      <PriorityCard item={item({ kind: "tension_window" })} />,
    );
    expect(tension).toContain("metric-accent");
    expect(tension).toContain("--tile-hue:var(--tile-stress)");
    const ecg = render(
      <PriorityCard item={item({ kind: "ecg_new_recording" })} />,
    );
    expect(ecg).toContain("--tile-hue:var(--tile-strain)");
    // Utility kinds carry no metric identity — status alone speaks.
    const sync = render(<PriorityCard item={item({ kind: "sync_issue" })} />);
    expect(sync).not.toContain("metric-accent");
  });

  it("gives the milestone card the quiet reached treatment instead of the generic fade-in", () => {
    const html = render(
      <PriorityCard item={item({ kind: "milestone", status: "success" })} />,
    );
    expect(html).toContain("milestone-reached");
    expect(html).not.toContain("animate-insight-in");
    // The success wash still carries the semantic border.
    expect(html).toContain("border-success/25");
  });

  it("renders a navigation action as a link carrying the href", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "sync_issue",
          actions: [
            {
              labelKey: "daily.action.reconnect",
              intent: "sync.reconnect",
              href: "/settings/integrations",
            },
          ],
        })}
      />,
    );
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain("Reconnect");
  });

  it("renders a non-navigation action as a button (no href)", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "coach_checkin",
          actions: [{ labelKey: "daily.action.logDose", intent: "dose.log" }],
        })}
      />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("Log dose");
  });

  it("resolves action label keys through the active locale", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "preventive_care",
          actions: [
            {
              labelKey: "daily.action.viewCheckups",
              intent: "checkup.view",
              href: "/checkups",
            },
          ],
        })}
      />,
    );
    expect(html).toContain("View check-ups");
  });
});
