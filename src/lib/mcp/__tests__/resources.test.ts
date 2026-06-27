import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    medication: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { MCP_RESOURCES, MCP_RESOURCE_URIS } from "../resources";
import { prisma } from "@/lib/db";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function resource(uri: string) {
  const def = MCP_RESOURCES.find((r) => r.uri === uri);
  if (!def) throw new Error(`resource ${uri} not registered`);
  return def;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MCP resource surface", () => {
  it("registers the fixed resources, none admin", () => {
    expect([...MCP_RESOURCE_URIS].sort()).toEqual([
      "healthlog://labs/catalogue",
      "healthlog://measurements/inventory",
      "healthlog://medications",
      "healthlog://profile",
      "healthlog://report/doctor-visit",
    ]);
    for (const uri of MCP_RESOURCE_URIS) {
      expect(uri).not.toMatch(/admin/i);
    }
  });
});

describe("healthlog://profile", () => {
  it("returns minimised, health-relevant profile data and omits identifiers", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 180,
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
      gender: "MALE",
      timezone: "Europe/Berlin",
      unitPreference: "metric",
      glucoseUnit: "mmol/L",
    } as never);

    const result = (await resource("healthlog://profile").read(CTX)) as Record<
      string,
      unknown
    >;

    // userId is narrowed from the session, never a caller argument.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(result.present).toBe(true);
    expect(result.heightCm).toBe(180);
    expect(typeof result.ageYears).toBe("number");
    expect(result.glucoseUnit).toBe("mmol/L");
    // No direct identifiers leak to the assistant.
    expect(Object.keys(result)).not.toContain("email");
    expect(Object.keys(result)).not.toContain("username");
    expect(Object.keys(result)).not.toContain("role");
  });

  it("returns { present: false } when the user row is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const result = (await resource("healthlog://profile").read(CTX)) as {
      present: boolean;
    };
    expect(result.present).toBe(false);
  });
});

describe("healthlog://medications", () => {
  it("lists medications + schedules scoped to the session user", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        name: "Med A",
        dose: "10mg",
        treatmentClass: "GENERIC",
        asNeeded: false,
        pausedAt: null,
        startsOn: null,
        endsOn: null,
        schedules: [
          {
            label: "Morning",
            dose: null,
            windowStart: "08:00",
            windowEnd: "10:00",
            timesOfDay: ["08:00"],
            daysOfWeek: null,
            rrule: null,
            rollingIntervalDays: null,
            scheduleType: "SCHEDULED",
          },
        ],
      },
    ] as never);

    const result = (await resource("healthlog://medications").read(
      CTX,
    )) as Record<string, unknown>;

    expect(prisma.medication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(result.present).toBe(true);
    expect(result.count).toBe(1);
    expect(Array.isArray(result.medications)).toBe(true);
  });

  it("returns { present: false } when no medications are tracked", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    const result = (await resource("healthlog://medications").read(CTX)) as {
      present: boolean;
      count: number;
    };
    expect(result.present).toBe(false);
    expect(result.count).toBe(0);
  });
});
