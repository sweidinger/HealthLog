/**
 * v1.18.7 (HIGH-2) — cross-surface shared-contract coverage.
 *
 * The grounding / tone / GLP-1-safety / metric-identifier-ban / forbidden-
 * filler contracts live once in `shared-contracts.ts`. These guards assert
 * that each surface that enforces a contract carries the canonical fragment
 * VERBATIM, in both hand-composed locales (de/en). A future edit that lets a
 * surface drift from the shared wording — the exact failure mode HIGH-2
 * documents — trips here instead of shipping silently.
 */
import { describe, expect, it } from "vitest";

import {
  grounding,
  toneContract,
  safetyGlp1,
  safetyAcute,
  metricIdentifierBan,
  forbiddenFiller,
  type ContractLocale,
} from "../shared-contracts";
import { getBaseSystemPrompt } from "../base-system";
import { getStrictInsightsSystemPrompt } from "../insight-generator";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";

// The narrative system prompts are module-private; re-derive the same
// composed shared block the generator appends, and assert each fragment is
// present by checking the generator module's exported builder indirectly.
import { SYSTEM_PROMPTS_FOR_TEST } from "@/lib/insights/narrative/period-narrative-generate";

const LOCALES: ContractLocale[] = ["de", "en"];

/** Which contracts each surface enforces (and must carry verbatim). */
const SURFACES: Record<
  string,
  {
    prompt: (l: ContractLocale) => string;
    contracts: Record<ContractLocale, string>[];
  }
> = {
  "insight-generator (comprehensive)": {
    prompt: (l) => getStrictInsightsSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
    ],
  },
  "base-system (status cards)": {
    prompt: (l) => getBaseSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
    ],
  },
  coach: {
    prompt: (l) => getCoachSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
    ],
  },
  // v1.21.0 (coach C1 MEDIUM-1) — the retrospective narrative now composes the
  // shared tone contract too, so it matches the warm house voice of the daily
  // briefing beside it. Its own descriptive-never-causal guards stay intact.
  "period-narrative": {
    prompt: (l) => SYSTEM_PROMPTS_FOR_TEST[l],
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
    ],
  },
};

describe("shared-contract cross-surface coverage", () => {
  for (const [surface, { prompt, contracts }] of Object.entries(SURFACES)) {
    for (const locale of LOCALES) {
      const text = prompt(locale);
      for (const contract of contracts) {
        const fragment = contract[locale];
        // Use a short, stable slice of the fragment as the assertion anchor —
        // the full fragment is long but must be present verbatim.
        it(`${surface} carries every enforced contract verbatim (${locale})`, () => {
          expect(text).toContain(fragment);
        });
      }
    }
  }

  it("the GLP-1 dose-safety contract reaches all four surfaces", () => {
    for (const locale of LOCALES) {
      expect(getStrictInsightsSystemPrompt(locale)).toContain(
        safetyGlp1[locale],
      );
      expect(getBaseSystemPrompt(locale)).toContain(safetyGlp1[locale]);
      expect(getCoachSystemPrompt(locale)).toContain(safetyGlp1[locale]);
      expect(SYSTEM_PROMPTS_FOR_TEST[locale]).toContain(safetyGlp1[locale]);
    }
  });

  it("the acute red-flag escalation contract reaches all four surfaces", () => {
    for (const locale of LOCALES) {
      expect(getStrictInsightsSystemPrompt(locale)).toContain(
        safetyAcute[locale],
      );
      expect(getBaseSystemPrompt(locale)).toContain(safetyAcute[locale]);
      expect(getCoachSystemPrompt(locale)).toContain(safetyAcute[locale]);
      expect(SYSTEM_PROMPTS_FOR_TEST[locale]).toContain(safetyAcute[locale]);
    }
  });
});
