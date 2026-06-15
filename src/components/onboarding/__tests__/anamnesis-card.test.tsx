/**
 * v1.17.1 — optional onboarding anamnesis card.
 *
 * Vitest runs in the Node environment here (no jsdom), so the
 * expand/collapse interaction is left to e2e. This file locks the two
 * contracts that matter for correctness:
 *   1. the about-me PUT body builder (what actually persists), and
 *   2. the collapsed SSR shape + i18n wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  AnamnesisCard,
  buildAnamnesisAboutMeBody,
} from "../AnamnesisCard";

describe("buildAnamnesisAboutMeBody", () => {
  const empty = { conditions: "", allergies: "" };

  it("returns null when both fields are blank (untouched card)", () => {
    expect(buildAnamnesisAboutMeBody("", empty)).toBeNull();
    expect(
      buildAnamnesisAboutMeBody("", { conditions: "   ", allergies: "\n" }),
    ).toBeNull();
  });

  it("preserves the existing aboutMe so it is never cleared", () => {
    const body = buildAnamnesisAboutMeBody("I'm an athlete.", {
      conditions: "Hypertension",
      allergies: "",
    });
    expect(body).toMatchObject({
      aboutMe: "I'm an athlete.",
      conditions: "Hypertension",
    });
    // Allergies omitted (blank) so the stored value isn't cleared.
    expect(body).not.toHaveProperty("allergies");
  });

  it("includes only the fields the user actually filled (no mass spread)", () => {
    const body = buildAnamnesisAboutMeBody("", {
      conditions: "  Type 2 diabetes ",
      allergies: " Penicillin ",
    });
    expect(body).toEqual({
      aboutMe: "",
      conditions: "Type 2 diabetes",
      allergies: "Penicillin",
    });
  });
});

describe("<AnamnesisCard> (collapsed SSR)", () => {
  function render() {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AnamnesisCard
          value={{ conditions: "", allergies: "" }}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );
  }

  it("renders the title + a collapsed (aria-expanded=false) toggle", () => {
    const html = render();
    expect(html).toContain("About your health (optional)");
    expect(html).toContain('aria-expanded="false"');
  });

  it("keeps the questions hidden until expanded", () => {
    const html = render();
    // The conditions textarea label only renders inside the expanded
    // panel; collapsed SSR must not include it.
    expect(html).not.toContain("Ongoing conditions");
  });
});
