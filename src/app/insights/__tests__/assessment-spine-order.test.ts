import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.12.2 — canonical metric-detail spine guard.
 *
 * v1.12.0 made the AI assessment the LAST content block on every metric
 * sub-page (primary → stat strip → chart → range → target → forecast →
 * assessment). The generic `HealthKitMetricPage` scaffold enforces this for
 * the ~29 HealthKit pages structurally; the six bespoke pages each hand-write
 * their body, so a future edit can silently slot a card after the assessment
 * (as `mood` and `medications` did before this release).
 *
 * This is a source-level structural guard: the assessment card element must be
 * the last JSX child of the page's `<SubPageShell>`. Asserting on the source
 * (rather than rendered markup) keeps the test deterministic — the preceding
 * blocks (`MetricTargetSummary`, `MoodInsightsSections`, `TherapyTimeline`)
 * all self-suppress on a data miss, so a render-order assertion would depend
 * on mocking the whole data layer.
 */

const PAGES_DIR = join(process.cwd(), "src", "app", "insights");

// Each bespoke page + the element that mounts its assessment card. The five
// `useInsightStatus`-backed pages render `<SlugInsightStatusCard>`; the
// medications page reads the richer `summary`-shaped route inline, so it
// renders `<InsightStatusCard>` directly.
const BESPOKE_PAGES: ReadonlyArray<{ slug: string; assessmentTag: string }> = [
  { slug: "weight", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "bmi", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "pulse", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "blood-pressure", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "mood", assessmentTag: "<SlugInsightStatusCard" },
  { slug: "medications", assessmentTag: "<InsightStatusCard" },
];

describe("bespoke metric-detail spine — assessment is the last block", () => {
  for (const { slug, assessmentTag } of BESPOKE_PAGES) {
    it(`renders the assessment card as the last SubPageShell child on /insights/${slug}`, () => {
      const source = readFileSync(
        join(PAGES_DIR, slug, "page.tsx"),
        "utf8",
      );

      // The render branch that carries the assessment is the final
      // `<SubPageShell>…</SubPageShell>` in the module (the empty-state
      // branches close their own shell earlier and never mount the card).
      const shellClose = source.lastIndexOf("</SubPageShell>");
      expect(shellClose, `${slug}: no closing </SubPageShell>`).toBeGreaterThan(
        -1,
      );
      const shellOpen = source.lastIndexOf("<SubPageShell", shellClose);
      expect(shellOpen, `${slug}: no opening <SubPageShell`).toBeGreaterThan(-1);

      const body = source.slice(shellOpen, shellClose);

      const assessmentIndex = body.lastIndexOf(assessmentTag);
      expect(
        assessmentIndex,
        `${slug}: assessment card ${assessmentTag} not found inside the shell`,
      ).toBeGreaterThan(-1);

      // All six bespoke pages render the assessment as a self-closing
      // element. Find the `/>` that closes it, then assert nothing but
      // whitespace separates that close from `</SubPageShell>`. The icon
      // passed as a prop (`<Scale … />`) self-closes BEFORE the element's own
      // `/>`, so the first `/>` after the assessment open is the icon's and
      // the second is the element's — scan for the last `/>` in the body,
      // which belongs to the trailing assessment element by construction.
      const selfClose = body.lastIndexOf("/>");
      expect(
        selfClose,
        `${slug}: assessment card is not self-closing as expected`,
      ).toBeGreaterThan(assessmentIndex);

      const trailing = body.slice(selfClose + 2).trim();
      expect(
        trailing,
        `${slug}: "${trailing.slice(0, 40)}" renders AFTER the assessment card — ` +
          `the assessment must be the last block on the canonical spine`,
      ).toBe("");
    });
  }
});
