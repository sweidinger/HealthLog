import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../messages/en.json";

/**
 * A failed read must never render as an absence of data.
 *
 * "No data yet" is a factual claim about the user's record. Making it when the
 * read failed is a false statement about their health history — worst of all on
 * the mental-wellbeing surface, where a user with months of screening results
 * was told, in a mental-health context, that they had never taken an
 * assessment.
 *
 * Each surface must tell three states apart: loading, failed, and genuinely
 * empty. These tests pin the failed/empty split; the loading branch is asserted
 * where it is SSR-observable.
 *
 * SSR-only convention (`renderToStaticMarkup`, no `@testing-library/react`), so
 * the error state is produced by seeding the query cache with a settled failure
 * rather than by driving a real fetch.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { gender: "FEMALE", modules: {} },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { MentalWellbeing } from "@/components/mental-health/mental-wellbeing";
import { MicronutrientsCard } from "@/components/insights/nutrients/micronutrients-card";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // An errored query would otherwise refetch on mount, and the observer
        // reports that intent as an optimistic pending state during the server
        // render — which would hide the very branch under test.
        retryOnMount: false,
        staleTime: Infinity,
      },
    },
  });
}

/**
 * Drive `queryKey` to a settled failure through the public prefetch path, so
 * the SSR render below observes exactly the state a real failed read leaves in
 * the cache.
 */
async function seedFailure(
  client: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  await client.prefetchQuery({
    queryKey: queryKey as unknown[],
    queryFn: () => Promise.reject(new Error("read failed")),
    retry: false,
  });
}

function render(node: React.ReactNode, client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("mental wellbeing — screening history", () => {
  const mh = en.mentalHealth;

  it("renders the error state with a retry when the history read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.mentalHealthAssessments());
    const html = render(<MentalWellbeing />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(mh.historyLoadError);
    expect(html).toContain(en.common.retry);
    // The load-bearing assertion: the instrument cards' "not taken yet" copy
    // must NOT appear. That sentence is a claim about the user's record.
    expect(html).not.toContain(mh.noResultYet);
  });

  it("still renders the instrument cards when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.mentalHealthAssessments(), {
      assessments: [],
    });
    const html = render(<MentalWellbeing />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    // An honest empty record: the cards render and invite a first check-in.
    expect(html).toContain(mh.noResultYet);
  });

  it("shows neither the empty copy nor an error while the read is in flight", () => {
    const html = render(<MentalWellbeing />, makeClient());
    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).not.toContain(mh.noResultYet);
  });
});

describe("micronutrients card", () => {
  const mn = en.nutrients.micronutrients;

  it("renders the error state with a retry when the nutrient read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.nutrientIntake(30));
    const html = render(<MicronutrientsCard />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(mn.loadError);
    expect(html).toContain(en.common.retry);
    expect(html).not.toContain(mn.emptyTitle);
  });

  it("still renders the empty state when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), { nutrients: [] });
    const html = render(<MicronutrientsCard />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).toContain(mn.emptyTitle);
  });
});

/**
 * The remaining surfaces in the sweep are pages whose render depends on the
 * router / module gate, which the SSR-only convention cannot drive. Pin their
 * contract structurally instead: each must read `isError` from its query and
 * hand a retry to the shared error card, so a later edit cannot quietly drop
 * the branch and fall back through to the empty state.
 */
describe("read-failure branch is wired on every swept surface", () => {
  const surfaces = [
    "src/components/mental-health/mental-wellbeing.tsx",
    "src/app/insights/workouts/page-client.tsx",
    "src/app/medications/[id]/page.tsx",
    "src/components/custom-metrics/custom-metric-values-list.tsx",
    "src/app/achievements/page.tsx",
    "src/components/insights/nutrients/micronutrients-card.tsx",
    "src/components/insights/sleep/chronotype-section.tsx",
  ] as const;

  for (const rel of surfaces) {
    it(`${rel} reads isError and offers a retry`, () => {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).toMatch(/isError/);
      // chronotype-section is the one surface that legitimately renders an
      // inline notice rather than the card (it sits inside a chart section),
      // so it is exempt from the retry affordance but not from the branch.
      if (!rel.endsWith("chronotype-section.tsx")) {
        expect(source).toMatch(/onRetry=/);
        expect(source).toMatch(/refetch/);
      }
    });
  }
});
