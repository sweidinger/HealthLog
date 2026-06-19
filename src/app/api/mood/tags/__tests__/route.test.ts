/**
 * v1.12.0 / v1.13.0 / v1.17.0 — `GET /api/mood/tags` exposes the rated-factor
 * metadata (`kind` / `scaleMin` / `scaleMax` / `inverse`) AND the effective
 * per-user set: own custom tags merged in (label decrypted, `custom: true`),
 * hidden catalogue tags omitted by default and surfaced under
 * `?include=hidden`. v1.17.0 layers custom groups, the layout blob (group
 * order + placements), `include=archived` (own inactive customs) and
 * `include=usage` (per-tag live-entry counts) on top.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const categoryFindMany = vi.fn();
const tagFindMany = vi.fn();
const hiddenFindMany = vi.fn();
const userFindUnique = vi.fn();
const linkGroupBy = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    moodTagCategory: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    moodTag: { findMany: (...a: unknown[]) => tagFindMany(...a) },
    moodTagHidden: { findMany: (...a: unknown[]) => hiddenFindMany(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    moodEntryTagLink: { groupBy: (...a: unknown[]) => linkGroupBy(...a) },
  },
}));

// Identity-ish crypto so the decrypted custom label is asserted in plaintext.
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
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

const CATEGORIES = [
  {
    id: "c1",
    key: "feelings",
    labelKey: "mood.tagCategory.feelings",
    icon: "Smile",
    userId: null,
    labelEncrypted: null,
  },
  {
    id: "mtc_custom",
    key: "custom",
    labelKey: "mood.tagCategory.custom",
    icon: "Tag",
    userId: null,
    labelEncrypted: null,
  },
];

const OWN_GROUP = {
  id: "cg1",
  key: "customcat:g1",
  labelKey: "customcat:g1",
  icon: "Stethoscope",
  userId: "user-1",
  labelEncrypted: "enc:Therapie",
};

const TAGS = [
  {
    id: "t_happy",
    categoryId: "c1",
    key: "happy",
    labelKey: "mood.tag.happy",
    icon: "Smile",
    kind: "BINARY",
    scaleMin: 1,
    scaleMax: 5,
    inverse: false,
    isActive: true,
    userId: null,
    labelEncrypted: null,
  },
  {
    id: "t_sad",
    categoryId: "c1",
    key: "sad",
    labelKey: "mood.tag.sad",
    icon: "Frown",
    kind: "BINARY",
    scaleMin: 1,
    scaleMax: 5,
    inverse: false,
    isActive: true,
    userId: null,
    labelEncrypted: null,
  },
  {
    id: "t_custom",
    categoryId: "mtc_custom",
    key: "custom:abc",
    labelKey: "custom:abc",
    icon: "Heart",
    kind: "BINARY",
    scaleMin: 1,
    scaleMax: 5,
    inverse: false,
    isActive: true,
    userId: "user-1",
    labelEncrypted: "enc:Migräne",
  },
];

const ARCHIVED_TAG = {
  id: "t_arch",
  categoryId: "mtc_custom",
  key: "custom:arch",
  labelKey: "custom:arch",
  icon: null,
  kind: "BINARY",
  scaleMin: 1,
  scaleMax: 5,
  inverse: false,
  isActive: false,
  userId: "user-1",
  labelEncrypted: "enc:Alt",
};

interface TagOut {
  key: string;
  labelKey: string | null;
  label: string | null;
  custom: boolean;
  kind: string;
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
  hidden?: boolean;
  archived?: boolean;
  usageCount?: number;
}
interface CategoryOut {
  key: string;
  labelKey: string | null;
  label: string | null;
  icon: string | null;
  custom: boolean;
  tags: TagOut[];
}
interface Body {
  data: { categories: CategoryOut[] };
}

function req(url = "http://localhost/api/mood/tags") {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  categoryFindMany.mockResolvedValue(CATEGORIES);
  tagFindMany.mockResolvedValue(TAGS);
  hiddenFindMany.mockResolvedValue([{ moodTagId: "t_sad" }]);
  userFindUnique.mockResolvedValue({ moodTagLayoutJson: null });
  linkGroupBy.mockResolvedValue([]);
});

function flat(body: Body): Record<string, TagOut> {
  const out: Record<string, TagOut> = {};
  for (const c of body.data.categories) for (const t of c.tags) out[t.key] = t;
  return out;
}

describe("GET /api/mood/tags — effective per-user set (v1.13.0)", () => {
  it("emits rated-factor metadata + custom/label fields and omits hidden by default", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const tags = flat((await res.json()) as Body);

    // Catalogue tag: custom=false, label=null, labelKey kept, metadata present.
    expect(tags.happy).toMatchObject({
      custom: false,
      label: null,
      labelKey: "mood.tag.happy",
      kind: "BINARY",
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    });
    expect(tags.happy.hidden).toBeUndefined();

    // Custom tag merged in: custom=true, decrypted label, labelKey null.
    expect(tags["custom:abc"]).toMatchObject({
      custom: true,
      label: "Migräne",
      labelKey: null,
    });

    // Hidden catalogue tag omitted by default.
    expect(tags.sad).toBeUndefined();

    // Tag query scopes to catalogue OR the caller's own customs.
    const tagWhere = tagFindMany.mock.calls[0]?.[0]?.where;
    expect(tagWhere.OR).toEqual([{ userId: null }, { userId: "user-1" }]);

    // Plain picker read never pays the usage groupBy.
    expect(linkGroupBy).not.toHaveBeenCalled();
  });

  it("surfaces hidden catalogue tags with hidden:true under ?include=hidden", async () => {
    const res = await GET(req("http://localhost/api/mood/tags?include=hidden"));
    const tags = flat((await res.json()) as Body);
    expect(tags.sad).toMatchObject({ hidden: true, custom: false });
    expect(tags.happy).toMatchObject({ hidden: false });
    // Custom tags never carry a hidden flag.
    expect(tags["custom:abc"].hidden).toBeUndefined();
  });
});

describe("GET /api/mood/tags — groups + layout + archived + usage (v1.17.0)", () => {
  it("returns own custom groups with decrypted label and custom:true on categories", async () => {
    categoryFindMany.mockResolvedValue([...CATEGORIES, OWN_GROUP]);
    tagFindMany.mockResolvedValue([
      ...TAGS,
      {
        ...TAGS[2],
        id: "t_c2",
        categoryId: "cg1",
        key: "custom:ing1",
        labelKey: "custom:ing1",
        labelEncrypted: "enc:Sitzung",
      },
    ]);
    const res = await GET(req());
    const body = (await res.json()) as Body;
    const group = body.data.categories.find((c) => c.key === "customcat:g1");
    expect(group).toMatchObject({
      custom: true,
      label: "Therapie",
      labelKey: null,
      icon: "Stethoscope",
    });
    expect(group?.tags.map((t) => t.key)).toEqual(["custom:ing1"]);
    // Seeded categories stay labelKey-driven.
    const feelings = body.data.categories.find((c) => c.key === "feelings");
    expect(feelings).toMatchObject({
      custom: false,
      label: null,
      labelKey: "mood.tagCategory.feelings",
    });
    // Category query scopes to seeded OR own groups.
    const catWhere = categoryFindMany.mock.calls[0]?.[0]?.where;
    expect(catWhere.OR).toEqual([{ userId: null }, { userId: "user-1" }]);
  });

  it("applies the layout blob: group order + catalogue-tag placement", async () => {
    categoryFindMany.mockResolvedValue([...CATEGORIES, OWN_GROUP]);
    userFindUnique.mockResolvedValue({
      moodTagLayoutJson: {
        groupOrder: ["customcat:g1", "custom", "feelings"],
        placements: { "customcat:g1": ["happy"] },
      },
    });
    const res = await GET(req());
    const body = (await res.json()) as Body;
    // `feelings` ends empty (happy placed away, sad hidden) → dropped.
    expect(body.data.categories.map((c) => c.key)).toEqual([
      "customcat:g1",
      "custom",
    ]);
    // Catalogue tag `happy` rendered inside the user's group (placement,
    // not a categoryId change) — gone from its home category.
    const group = body.data.categories.find((c) => c.key === "customcat:g1");
    expect(group?.tags.map((t) => t.key)).toEqual(["happy"]);
    const feelings = body.data.categories.find((c) => c.key === "feelings");
    expect(feelings).toBeUndefined(); // only hidden `sad` left → dropped
  });

  it("drops a stale layout placement (hidden tag) silently", async () => {
    categoryFindMany.mockResolvedValue([...CATEGORIES, OWN_GROUP]);
    userFindUnique.mockResolvedValue({
      moodTagLayoutJson: {
        placements: { "customcat:g1": ["sad", "ghost"] }, // sad is hidden
      },
    });
    const res = await GET(req());
    const body = (await res.json()) as Body;
    expect(
      body.data.categories.find((c) => c.key === "customcat:g1"),
    ).toBeUndefined(); // nothing visible placed → empty → dropped (plain read)
  });

  it("returns archived own customs with archived:true under include=archived and keeps empty own groups", async () => {
    categoryFindMany.mockResolvedValue([...CATEGORIES, OWN_GROUP]);
    tagFindMany.mockResolvedValue([...TAGS, ARCHIVED_TAG]);
    const res = await GET(
      req("http://localhost/api/mood/tags?include=hidden,archived"),
    );
    const body = (await res.json()) as Body;
    const tags = flat(body);
    expect(tags["custom:arch"]).toMatchObject({
      custom: true,
      archived: true,
      label: "Alt",
    });
    expect(tags["custom:abc"]).toMatchObject({ archived: false });
    // Catalogue rows never carry the archived flag.
    expect(tags.happy.archived).toBeUndefined();
    // The archived read lifts isActive only for the caller's own rows.
    const tagWhere = tagFindMany.mock.calls[0]?.[0]?.where;
    expect(tagWhere).toEqual({
      OR: [{ userId: null, isActive: true }, { userId: "user-1" }],
    });
    // Empty own group kept on a management read.
    expect(
      body.data.categories.find((c) => c.key === "customcat:g1"),
    ).toMatchObject({ custom: true, tags: [] });
  });

  it("emits usageCount per tag under include=usage (live entries only)", async () => {
    linkGroupBy.mockResolvedValue([
      { moodTagId: "t_happy", _count: { _all: 7 } },
    ]);
    const res = await GET(req("http://localhost/api/mood/tags?include=usage"));
    const tags = flat((await res.json()) as Body);
    expect(tags.happy.usageCount).toBe(7);
    expect(tags["custom:abc"].usageCount).toBe(0);
    expect(linkGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["moodTagId"],
        where: { moodEntry: { userId: "user-1", deletedAt: null } },
      }),
    );
  });
});
