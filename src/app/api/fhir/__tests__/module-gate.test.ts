/**
 * `/api/fhir/*` — doctorReport module gate.
 *
 * The FHIR REST face serves the same whole-record aggregate as
 * `/api/export/health-record`, including the decrypted insurance number on
 * the Patient resource. The export gates on the `doctorReport` module; the
 * FHIR routes did not, so the module could be off and `$everything` still
 * returned the full Bundle to the same token.
 *
 * REFUSE, not omit — a whole-record export has no truthful partial answer.
 * Every data route 403s with the shared `module.disabled` envelope; only the
 * static CapabilityStatement at `/api/fhir/metadata` stays open (server
 * metadata, no user data).
 *
 * Behavioural: the assertions read status codes and check that no aggregate
 * was ever loaded, so removing a gate turns them red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
// The module gate itself is NOT mocked — the whole point is to exercise the
// real resolver and the real 403 envelope. Only its data sources are stubbed,
// so the module state is driven the same way production drives it: through
// the persisted `modulePreferencesJson` allowlist.
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    cycleProfile: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/modules/operator-availability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/modules/operator-availability")
    >();
  return { ...actual, getOperatorModuleAvailability: vi.fn() };
});
vi.mock("@/lib/fhir/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fhir/rest")>();
  return { ...actual, loadFhirContext: vi.fn() };
});
vi.mock("@/lib/fhir/resources", () => ({
  GERMAN_ATC_DEFAULT_LOCALES: ["de"],
  patientResource: vi.fn(() => ({ resourceType: "Patient", id: "p-1" })),
  coverageResource: vi.fn(() => null),
  observationsFromReportData: vi.fn(() => []),
  medicationStatementsFromReportData: vi.fn(() => []),
  medicationAdministrationsFromReportData: vi.fn(() => []),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as patientGet } from "../Patient/route";
import { GET as observationGet } from "../Observation/route";
import { GET as medStatementGet } from "../MedicationStatement/route";
import { GET as medAdminGet } from "../MedicationAdministration/route";
import { GET as everythingGet } from "../$everything/route";
import { GET as metadataGet } from "../metadata/route";

import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { MODULE_DISABLED_ERROR_CODE, MODULE_KEYS } from "@/lib/modules/gate";
import { getOperatorModuleAvailability } from "@/lib/modules/operator-availability";
import { loadFhirContext } from "@/lib/fhir/rest";
import { prisma } from "@/lib/db";

/**
 * Drive the REAL gate the way production does — through the persisted
 * `modulePreferencesJson` disabled-allowlist, where only a literal `false`
 * turns a module off.
 */
function setDoctorReportModule(enabled: boolean): void {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    gender: null,
    disableCoach: false,
    modulePreferencesJson: enabled ? {} : { doctorReport: false },
  } as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
}

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

/** Every data route under `/api/fhir`, by the path a caller would hit. */
const DATA_ROUTES: ReadonlyArray<
  [string, (req: NextRequest) => Promise<Response>]
> = [
  ["Patient", patientGet],
  ["Observation", observationGet],
  ["MedicationStatement", medStatementGet],
  ["MedicationAdministration", medAdminGet],
  ["$everything", everythingGet],
];

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/fhir/${path}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now(),
  } as never);
  // Operator layer available for every module; the per-user layer is what
  // each test drives.
  vi.mocked(getOperatorModuleAvailability).mockResolvedValue(
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as never,
  );
  vi.mocked(loadFhirContext).mockResolvedValue({
    data: {} as never,
    identity: { insuranceNumber: "A123456789" },
    germanAtc: false,
  });
});

describe("/api/fhir/* — doctorReport module gate", () => {
  describe.each(DATA_ROUTES)("GET /api/fhir/%s", (path, handler) => {
    it("403s with module.disabled when the module is off", async () => {
      setDoctorReportModule(false);

      const res = await handler(req(path));
      expect(res.status).toBe(403);

      const body = (await res.json()) as {
        data: unknown;
        error: string;
        meta?: { errorCode?: string; module?: string };
      };
      expect(body.data).toBeNull();
      expect(body.meta?.errorCode).toBe(MODULE_DISABLED_ERROR_CODE);
      expect(body.meta?.module).toBe("doctorReport");

      // Refused before any record was assembled — the insurance number
      // never left the store.
      expect(loadFhirContext).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("A123456789");
    });

    it("serves the Bundle when the module is on", async () => {
      setDoctorReportModule(true);

      const res = await handler(req(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(
        "application/fhir+json",
      );

      const bundle = (await res.json()) as { resourceType: string };
      expect(bundle.resourceType).toBe("Bundle");
      expect(loadFhirContext).toHaveBeenCalledWith("user-1");
    });
  });

  it("leaves the static CapabilityStatement reachable while the module is off", async () => {
    // Server metadata, no user data — the one FHIR route that stays open.
    setDoctorReportModule(false);
    const res = await metadataGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resourceType: string };
    expect(body.resourceType).toBe("CapabilityStatement");
  });
});
