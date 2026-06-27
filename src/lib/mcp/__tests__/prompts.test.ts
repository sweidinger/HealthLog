import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));

import { MCP_PROMPTS, MCP_PROMPT_NAMES } from "../prompts";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function prompt(name: string) {
  const def = MCP_PROMPTS.find((p) => p.name === name);
  if (!def) throw new Error(`prompt ${name} not registered`);
  return def;
}

/** Extract the JSON data block the prompt embeds in its user message. */
function parseData(text: string): Record<string, unknown> {
  const marker = "JSON):\n";
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error("no data block in prompt message");
  return JSON.parse(text.slice(idx + marker.length));
}

/** A minimal but representative doctor-report payload. */
function reportFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    period: {
      days: 90,
      since: "2026-03-29T00:00:00.000Z",
      start: "2026-03-29T00:00:00.000Z",
      end: "2026-06-27T00:00:00.000Z",
    },
    patient: {
      username: "tester",
      fullName: "A Person",
      dateOfBirth: "1990-01-01",
      gender: "female",
      heightCm: 170,
    },
    practiceName: null,
    measurements: {},
    stats: {
      WEIGHT: { avg: 80.4, min: 79, max: 82, count: 30, latest: 80 },
      RESTING_HEART_RATE: { avg: 58, min: 52, max: 66, count: 45, latest: 60 },
    },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseUnit: "mgdl",
    glucoseClinical: { stillLearning: true, stillLearningReason: "thin" },
    bmi: 24.1,
    compliance: {
      Ramipril: { total: 90, taken: 86, skipped: 0, missed: 4 },
    },
    medications: [{ name: "Ramipril", dose: "5 mg", schedules: [] }],
    mood: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MCP prompt registry — surface", () => {
  it("registers the doctor_visit_summary prompt with an args schema", () => {
    expect([...MCP_PROMPT_NAMES]).toContain("doctor_visit_summary");
    const def = prompt("doctor_visit_summary");
    expect(def.title).toBeTruthy();
    expect(def.description).toBeTruthy();
    expect(def.argsShape).toHaveProperty("window");
  });
});

describe("doctor_visit_summary — grounding + structure", () => {
  it("assembles a structured summary from the real doctor-report data", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );

    const res = await prompt("doctor_visit_summary").run(CTX, {
      window: "last90days",
    });

    // One user message carrying framing + data.
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
    const text = res.messages[0].content.text;

    // The window threads through to the data path (trailing 90 days).
    expect(collectDoctorReportData).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ days: 90 }),
    );

    const data = parseData(text);
    const vitals = data.vitals as Array<Record<string, unknown>>;
    const weight = vitals.find((v) => v.metric === "WEIGHT")!;
    const rhr = vitals.find((v) => v.metric === "RESTING_HEART_RATE")!;

    // Units + reference bands ride along, server-side.
    expect(weight.unit).toBe("kg");
    expect(weight.referenceBand).toBeNull(); // no universal weight band
    expect(rhr.unit).toBe("bpm");
    expect(rhr.referenceBand).toEqual({ low: 50, high: 100 });

    // Values are the server-computed ones — no fabrication.
    expect(weight.latest).toBe(80);
    expect(rhr.avg).toBe(58);

    // Compliance is the ledger-derived adherence (86/90 → 96 %).
    const compliance = data.compliance as Array<Record<string, unknown>>;
    expect(compliance[0].adherencePct).toBe(96);
  });

  it("injects the grounding framing — no diagnosis, no invented values", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const res = await prompt("doctor_visit_summary").run(CTX, {});
    const text = res.messages[0].content.text;
    expect(text).toMatch(/server-side/i);
    expect(text).toMatch(/do not.*diagnos/i);
    expect(text).toMatch(/do not (invent|estimate|infer)/i);
  });

  it("omits the glucose panel while still learning and mood when absent", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    expect(data).not.toHaveProperty("glucosePanel"); // stillLearning → withheld
    expect(data).not.toHaveProperty("mood"); // mood null
  });

  it("includes labs with reference ranges and caps the list (token budget)", async () => {
    const labResults = Array.from({ length: 60 }, (_, i) => ({
      panel: null,
      analyte: `Analyte-${i}`,
      value: i,
      valueText: null,
      unit: "mg/dL",
      referenceLow: 0,
      referenceHigh: 100,
      takenAt: "2026-06-01T00:00:00.000Z",
      count: 1,
    }));
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture({ labResults }) as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    const labs = data.labs as Array<Record<string, unknown>>;
    expect(labs.length).toBe(50); // capped from 60
    expect(labs[0]).toHaveProperty("referenceHigh", 100);
  });

  it("does not leak patient name into the summary", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    const patient = data.patient as Record<string, unknown>;
    expect(patient).not.toHaveProperty("fullName");
    expect(patient).not.toHaveProperty("username");
    expect(patient.dateOfBirth).toBe("1990-01-01");
  });
});
