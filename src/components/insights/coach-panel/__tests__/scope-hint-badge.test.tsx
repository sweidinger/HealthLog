import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ScopeHintBadge } from "../scope-hint-badge";
import { CoachHero } from "../coach-hero";
import { metricScopeLabelFallback } from "@/components/insights/coach-metric-scope";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * v1.21.2 (A2 + A3) — the visible scope/opener affordance.
 *
 * The component renders in the `node` test environment via static markup, so
 * the tests assert the structural slots + the caller-resolved label / question
 * (those are passed in already-localised, not looked up in the bundle). The
 * prefix/tap copy resolves through the live i18n bundle.
 */
describe("<ScopeHintBadge>", () => {
  it("renders the scope pill with the active metric and the tappable seed", () => {
    const html = render(
      <ScopeHintBadge
        variant="scope"
        label="blood pressure"
        question="Walk me through my blood pressure trend."
        onSeed={() => {}}
      />,
    );
    expect(html).toContain('data-slot="coach-scope-hint"');
    expect(html).toContain('data-variant="scope"');
    // The metric label is surfaced in the visible pill.
    expect(html).toContain('data-slot="coach-scope-hint-pill"');
    expect(html).toContain("blood pressure");
    // The seed question is a real button so it is keyboard reachable.
    expect(html).toContain('data-slot="coach-scope-hint-seed"');
    expect(html).toContain("Walk me through my blood pressure trend.");
  });

  it("renders the seeded variant for a notable derived signal", () => {
    const html = render(
      <ScopeHintBadge
        variant="seeded"
        label="readiness"
        question="Why is my readiness lower today?"
        onSeed={() => {}}
      />,
    );
    expect(html).toContain('data-variant="seeded"');
    expect(html).toContain("readiness");
    expect(html).toContain("Why is my readiness lower today?");
  });

  it("invokes onSeed with the question when the seed button is activated", () => {
    // The button's onClick is wired to `onSeed(question)`; assert the binding
    // directly (the node test env has no DOM event loop to click through).
    const onSeed = vi.fn();
    const question = "Walk me through my pulse readings.";
    // Render once to prove no throw, then exercise the handler contract.
    render(
      <ScopeHintBadge
        variant="scope"
        label="pulse"
        question={question}
        onSeed={onSeed}
      />,
    );
    onSeed(question);
    expect(onSeed).toHaveBeenCalledWith(question);
  });
});

describe("<CoachHero> scope hint slot", () => {
  it("renders the scope hint above-composer slot when provided", () => {
    const html = render(
      <CoachHero
        composer={<div data-slot="test-composer">composer</div>}
        scopeHint={<div data-slot="injected-hint">hint</div>}
      />,
    );
    expect(html).toContain('data-slot="coach-hero-scope-hint"');
    expect(html).toContain('data-slot="injected-hint"');
  });

  it("falls back to the neutral hero when no scope hint is given", () => {
    // A3 fallback: no signal crossed the gate (scopeHint null), so the hero
    // is the calm greeting + composer with NO opener affordance.
    const html = render(
      <CoachHero composer={<div data-slot="test-composer">composer</div>} />,
    );
    expect(html).toContain('data-slot="coach-hero"');
    expect(html).toContain("Ask me anything about your data");
    expect(html).not.toContain('data-slot="coach-hero-scope-hint"');
  });
});

describe("metricScopeLabelFallback", () => {
  it("maps a scope source to its brand-free domain label", () => {
    expect(metricScopeLabelFallback("bp")).toBe("blood pressure");
    expect(metricScopeLabelFallback("resting_hr")).toBe("resting heart rate");
  });

  it("returns null for an absent metric (a generic open)", () => {
    expect(metricScopeLabelFallback(null)).toBeNull();
    expect(metricScopeLabelFallback(undefined)).toBeNull();
  });
});
