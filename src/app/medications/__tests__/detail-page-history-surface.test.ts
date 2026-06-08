/**
 * v1.15.18 — the `/medications/[id]` detail page is the tabbed shell.
 *
 * The page owns auth + the medication read and delegates the rest to
 * `<MedicationDetailTabs>` (the tab strip, `?tab=` URL state, the hero
 * and the wizard / advanced affordances). Source-level guards (the page
 * is a client component with `use()` + hooks, so a full render is
 * heavier than the contract warrants):
 *   - it renders `MedicationDetailTabs` and nothing tab-specific itself;
 *   - it carries no `TodaysDoseCard` (lives only on the list page);
 *   - it hosts neither the wizard nor the modal advanced sheet directly
 *     (those live inside the tab component).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/app/medications/[id]/page.tsx"),
  "utf8",
);

describe("medication detail page is the tabbed shell (v1.15.18)", () => {
  it("delegates to MedicationDetailTabs", () => {
    expect(source).toContain("MedicationDetailTabs");
  });

  it("does not import or render TodaysDoseCard", () => {
    expect(source).not.toContain("TodaysDoseCard");
    expect(source).not.toContain("todays-dose-card");
  });

  it("does not host the wizard or the modal advanced sheet directly", () => {
    expect(source).not.toContain("AdvancedSettingsSheet");
    expect(source).not.toContain("MedicationWizardDialog");
  });
});
