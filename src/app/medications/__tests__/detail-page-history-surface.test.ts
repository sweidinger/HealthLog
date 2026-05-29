/**
 * v1.5.6 G-1 §3 — the `/medications/[id]` detail page is a pure
 * history surface.
 *
 * Source-level guards (the page is a client component with `use()`
 * + hooks, so a full render is heavier than the contract warrants):
 *   - no `TodaysDoseCard` import or render (removed from the detail
 *     page; it lives only on the list page);
 *   - no `isToday` / `todayEvent` derivations (dead once the card is
 *     gone);
 *   - no `landingIntent` / `wizardIntent` / `openWizardWithIntent`
 *     plumbing (the header dropdown is the only wizard entry, landing
 *     on Step 1);
 *   - the page hosts the `AdvancedSettingsSheet` and renders an
 *     editable cadence row (the v1.6.0 editor opens directly from the
 *     row, so `hideEdit` is gone).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/app/medications/[id]/page.tsx"),
  "utf8",
);

describe("medication detail page is a pure history surface (G-1 §3)", () => {
  it("does not import or render TodaysDoseCard", () => {
    expect(source).not.toContain("TodaysDoseCard");
    expect(source).not.toContain("todays-dose-card");
  });

  it("drops the dead isToday / todayEvent derivations", () => {
    expect(source).not.toContain("isToday");
    expect(source).not.toContain("todayEvent");
  });

  it("drops the landingIntent plumbing", () => {
    expect(source).not.toContain("landingIntent");
    expect(source).not.toContain("wizardIntent");
    expect(source).not.toContain("openWizardWithIntent");
  });

  it("hosts the AdvancedSettingsSheet and an editable cadence row", () => {
    expect(source).toContain("AdvancedSettingsSheet");
    // v1.6.0 — the cadence row opens the editor directly; the dead
    // `hideEdit` prop is gone.
    expect(source).not.toContain("hideEdit");
  });
});
