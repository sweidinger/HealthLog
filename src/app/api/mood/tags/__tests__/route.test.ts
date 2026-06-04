/**
 * v1.12.0 — `GET /api/mood/tags` must expose the rated-factor metadata
 * (`kind` / `scaleMin` / `scaleMax` / `inverse`) so the client can branch
 * between binary toggle chips and rated segmented controls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const categoryFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    moodTagCategory: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/mood/tags — rated-factor catalog metadata (v1.12.0)", () => {
  it("selects + emits kind / scaleMin / scaleMax / inverse per tag", async () => {
    categoryFindMany.mockResolvedValue([
      {
        key: "factors",
        labelKey: "mood.tagCategory.factors",
        icon: "SlidersHorizontal",
        tags: [
          {
            key: "factor_work",
            labelKey: "mood.tag.factorWork",
            icon: "Briefcase",
            kind: "RATED",
            scaleMin: 1,
            scaleMax: 5,
            inverse: false,
          },
          {
            key: "factor_conflict",
            labelKey: "mood.tag.factorConflict",
            icon: "Swords",
            kind: "RATED",
            scaleMin: 1,
            scaleMax: 2,
            inverse: true,
          },
        ],
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        categories: Array<{
          key: string;
          tags: Array<{
            key: string;
            kind: string;
            scaleMin: number;
            scaleMax: number;
            inverse: boolean;
          }>;
        }>;
      };
    };

    // The Prisma select must request the new columns.
    const selectArg = categoryFindMany.mock.calls[0]?.[0] as {
      select: { tags: { select: Record<string, boolean> } };
    };
    expect(selectArg.select.tags.select).toMatchObject({
      kind: true,
      scaleMin: true,
      scaleMax: true,
      inverse: true,
    });

    const factor = body.data.categories[0].tags[0];
    expect(factor.kind).toBe("RATED");
    expect(factor.scaleMin).toBe(1);
    expect(factor.scaleMax).toBe(5);
    expect(factor.inverse).toBe(false);

    const conflict = body.data.categories[0].tags[1];
    expect(conflict.scaleMax).toBe(2);
    expect(conflict.inverse).toBe(true);
  });
});
