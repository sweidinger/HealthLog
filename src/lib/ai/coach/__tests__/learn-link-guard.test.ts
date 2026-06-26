/**
 * v1.21.0 (NEW-C C-3) — the Coach Learn-link post-filter. A published
 * `/learn/<slug>` is kept verbatim; a fabricated one (a slug not in the
 * catalog) is neutralised, so the catalog's "impossible by construction" claim
 * becomes an enforced guarantee rather than a prompt promise.
 */
import { describe, expect, it } from "vitest";

import { scrubUnknownLearnLinks } from "@/lib/ai/coach/learn-link-guard";
import { LEARN_GUIDES } from "@/lib/ai/coach/learn-catalog";

const REAL = LEARN_GUIDES.find((g) => g.slug === "resting-heart-rate")!;

describe("scrubUnknownLearnLinks", () => {
  it("returns the input unchanged when there is no /learn reference", () => {
    const reply = "Your resting heart rate is settling nicely this week.";
    const out = scrubUnknownLearnLinks(reply);
    expect(out.text).toBe(reply);
    expect(out.dropped).toEqual([]);
  });

  it("keeps a published /learn link verbatim (absolute URL)", () => {
    const reply = `Worth a read — more on this: ${REAL.url}.`;
    const out = scrubUnknownLearnLinks(reply);
    expect(out.text).toContain(REAL.url);
    expect(out.dropped).toEqual([]);
  });

  it("drops a fabricated /learn slug and reports it", () => {
    const reply =
      "That can drift with stress. More on this: https://healthlog.dev/learn/lower-your-cortisol-fast — give it a look.";
    const out = scrubUnknownLearnLinks(reply);
    expect(out.dropped).toContain("lower-your-cortisol-fast");
    expect(out.text).not.toContain("lower-your-cortisol-fast");
    expect(out.text).not.toContain("/learn/");
    // The surrounding sentence survives.
    expect(out.text).toContain("That can drift with stress");
    expect(out.text).toContain("give it a look");
  });

  it("drops a fabricated relative /learn link", () => {
    const reply = "See /learn/made-up-topic for the details.";
    const out = scrubUnknownLearnLinks(reply);
    expect(out.dropped).toContain("made-up-topic");
    expect(out.text).not.toContain("/learn/");
  });

  it("keeps the real link and drops the fake one in the same reply", () => {
    const reply = `Two reads: ${REAL.url} and https://healthlog.dev/learn/fictional-guide.`;
    const out = scrubUnknownLearnLinks(reply);
    expect(out.text).toContain(REAL.url);
    expect(out.text).not.toContain("fictional-guide");
    expect(out.dropped).toEqual(["fictional-guide"]);
  });

  it("is case-insensitive on the slug match", () => {
    // A real slug in mixed case still resolves as published (kept).
    const reply = "Read: https://healthlog.dev/learn/Resting-Heart-Rate.";
    const out = scrubUnknownLearnLinks(reply);
    expect(out.dropped).toEqual([]);
    expect(out.text).toContain("Resting-Heart-Rate");
  });
});
