import { describe, expect, it } from "vitest";

import { coachMaximizeHref } from "../coach-drawer";

/**
 * v1.28.52 (Documents R3) — the drawer's maximize control must preserve scope
 * when it hands off to the full page. `coachMaximizeHref` pins the continuity
 * rules so a doc-scoped drawer never expands into a blank `/coach`:
 *
 *   - a live conversation id (a turn created the thread) wins → `/coach?c=<id>`
 *     so the exact thread re-opens, scope and all;
 *   - else a document scope (maximized before the first turn) → `/coach?doc=<id>`;
 *   - else the plain new-chat surface.
 */
describe("coachMaximizeHref (Coach drawer maximize continuity)", () => {
  it("re-opens an existing thread by conversation id", () => {
    expect(coachMaximizeHref("conv-1", "doc-1")).toBe("/coach?c=conv-1");
  });

  it("prefers the conversation id even when no document scope exists", () => {
    expect(coachMaximizeHref("conv-1", null)).toBe("/coach?c=conv-1");
    expect(coachMaximizeHref("conv-1", undefined)).toBe("/coach?c=conv-1");
  });

  it("falls back to the document scope for a pre-first-turn doc chat", () => {
    expect(coachMaximizeHref(null, "doc-1")).toBe("/coach?doc=doc-1");
  });

  it("lands on the plain new-chat surface with neither thread nor document", () => {
    expect(coachMaximizeHref(null, null)).toBe("/coach");
    expect(coachMaximizeHref(null, undefined)).toBe("/coach");
  });
});
