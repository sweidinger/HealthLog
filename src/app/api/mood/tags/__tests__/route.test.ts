/**
 * v1.12.0 / v1.13.0 — `GET /api/mood/tags` exposes the rated-factor metadata
 * (`kind` / `scaleMin` / `scaleMax` / `inverse`) AND the v1.13.0 effective
 * per-user set: own custom tags merged in (label decrypted, `custom: true`),
 * hidden catalogue tags omitted by default and surfaced under
 * `?include=hidden`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const categoryFindMany = vi.fn();
const tagFindMany = vi.fn();
const hiddenFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    moodTagCategory: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    moodTag: { findMany: (...a: unknown[]) => tagFindMany(...a) },
    moodTagHidden: { findMany: (...a: unknown[]) => hiddenFindMany(...a) },
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
  { id: "c1", key: "feelings", labelKey: "mood.tagCategory.feelings", icon: "Smile" },
  { id: "mtc_custom", key: "custom", labelKey: "mood.tagCategory.custom", icon: "Tag" },
];

const TAGS = [
  { id: "t_happy", categoryId: "c1", key: "happy", labelKey: "mood.tag.happy", icon: "Smile", kind: "BINARY", scaleMin: 1, scaleMax: 5, inverse: false, userId: null, labelEncrypted: null },
  { id: "t_sad", categoryId: "c1", key: "sad", labelKey: "mood.tag.sad", icon: "Frown", kind: "BINARY", scaleMin: 1, scaleMax: 5, inverse: false, userId: null, labelEncrypted: null },
  { id: "t_custom", categoryId: "mtc_custom", key: "custom:abc", labelKey: "custom:abc", icon: "Heart", kind: "BINARY", scaleMin: 1, scaleMax: 5, inverse: false, userId: "user-1", labelEncrypted: "enc:Migräne" },
];

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
}
interface Body {
  data: { categories: Array<{ key: string; tags: TagOut[] }> };
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
