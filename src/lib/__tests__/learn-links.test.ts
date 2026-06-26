import { describe, it, expect } from "vitest";

import { LEARN_GUIDES } from "@/lib/ai/coach/learn-catalog";
import { LEARN_LINKS, learnUrl, learnLinkForMetric } from "../learn-links";

const CATALOG_SLUGS = new Set(LEARN_GUIDES.map((g) => g.slug));

describe("learn-links registry", () => {
  it("every mapped concept points at a slug that exists in the catalog", () => {
    for (const [concept, slug] of Object.entries(LEARN_LINKS)) {
      expect(CATALOG_SLUGS.has(slug), `${concept} → ${slug}`).toBe(true);
    }
  });

  it("learnUrl mints the catalog URL for a known slug and null otherwise", () => {
    const sample = LEARN_GUIDES[0]!;
    expect(learnUrl(sample.slug)).toBe(sample.url);
    expect(learnUrl(sample.slug)).toMatch(/^https:\/\/healthlog\.dev\/learn\//);
    expect(learnUrl("not-a-real-slug")).toBeNull();
    expect(learnUrl("")).toBeNull();
  });

  it("learnLinkForMetric resolves a mapped metric to its guide", () => {
    const guide = learnLinkForMetric("RESTING_HEART_RATE");
    expect(guide).not.toBeNull();
    expect(guide?.slug).toBe("resting-heart-rate");
    expect(guide?.url).toBe(learnUrl("resting-heart-rate"));
  });

  it("learnLinkForMetric fails closed for an unmapped id", () => {
    expect(learnLinkForMetric("TOTALLY_UNKNOWN_METRIC")).toBeNull();
    expect(learnLinkForMetric("")).toBeNull();
  });

  it("learnUrl is the only path — every guide URL stays on the public learn base", () => {
    for (const g of LEARN_GUIDES) {
      expect(learnUrl(g.slug)).toBe(g.url);
      expect(g.url).toMatch(/^https:\/\/healthlog\.dev\/learn\/[a-z0-9-]+$/);
    }
  });
});
