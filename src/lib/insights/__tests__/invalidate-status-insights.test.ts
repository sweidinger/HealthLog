/**
 * v1.8.0 — measurement-driven per-metric assessment invalidation.
 *
 * A fresh measurement of a given type must drop the cached
 * `insights.<scope>-status.<locale>` rows for the scopes that reading
 * dirties, so the next mount / nightly warm pass regenerates them
 * against the new data instead of serving the pre-measurement text for
 * the rest of the day. These tests pin the type → scope mapping and the
 * delete shape without a live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();
const enqueueStatusGeneration = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { deleteMany: (...a: unknown[]) => deleteMany(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
  },
}));

vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...a: unknown[]) => enqueueStatusGeneration(...a),
}));

import { invalidateStatusInsightsForTypes } from "../comprehensive-generate";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 0 });
  enqueueStatusGeneration.mockResolvedValue(undefined);
  userFindUnique.mockResolvedValue({ locale: "de" });
});

/** Distinct scopes the invalidator enqueued a regenerate for. */
function enqueuedScopes(): string[] {
  return [
    ...new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { metric: string }).metric,
      ),
    ),
  ].sort();
}

function deletedScopes(): string[] {
  const arg = deleteMany.mock.calls[0][0];
  // Each OR clause is `{ action: { startsWith: "insights.<scope>-status." } }`.
  return (arg.where.OR as Array<{ action: { startsWith: string } }>)
    .map((c) => c.action.startsWith.replace(/^insights\.(.+)-status\.$/, "$1"))
    .sort();
}

describe("invalidateStatusInsightsForTypes", () => {
  it("maps WEIGHT to weight + bmi + general", async () => {
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deletedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("u1");
  });

  it("maps both blood-pressure components to blood-pressure + general", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
    expect(deletedScopes()).toEqual(["blood-pressure", "general"]);
  });

  it("maps PULSE and RESTING_HEART_RATE to pulse + general (+ the resting-HR generic scope)", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "PULSE",
      "RESTING_HEART_RATE",
    ]);
    // PULSE feeds the specialised pulse + general scopes; RESTING_HEART_RATE
    // feeds those too AND carries its own generic assessment card
    // (`metric:RESTING_HEART_RATE`), so all three are dirtied.
    expect(deletedScopes()).toEqual([
      "general",
      "metric:RESTING_HEART_RATE",
      "pulse",
    ]);
  });

  it("maps a metric with no specialised scope to general + its generic scope", async () => {
    // BLOOD_GLUCOSE has no specialised assessment, but v1.8.7.1 gives it a
    // generic `metric:BLOOD_GLUCOSE` card, so a fresh reading dirties the
    // general overview AND that generic scope.
    await invalidateStatusInsightsForTypes("u1", ["BLOOD_GLUCOSE"]);
    expect(deletedScopes()).toEqual(["general", "metric:BLOOD_GLUCOSE"]);
  });

  it("dedupes scopes across a mixed batch", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "WEIGHT",
      "PULSE",
      "BLOOD_GLUCOSE",
    ]);
    // weight + bmi + general (WEIGHT) ∪ pulse + general (PULSE) ∪
    // general + metric:BLOOD_GLUCOSE (BLOOD_GLUCOSE)
    expect(deletedScopes()).toEqual([
      "bmi",
      "general",
      "metric:BLOOD_GLUCOSE",
      "pulse",
      "weight",
    ]);
  });

  it("is a no-op for an empty type set (no DB call)", async () => {
    await invalidateStatusInsightsForTypes("u1", []);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues a debounced regenerate for every dirtied scope, the user's locale only", async () => {
    userFindUnique.mockResolvedValue({ locale: "de" });
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    // weight + bmi + general, each warmed once for the user's resolved locale.
    expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(3);
    const locales = new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { locale: string }).locale,
      ),
    );
    expect([...locales]).toEqual(["de"]);
  });

  it("resolves the user's locale (en) for the regenerate, never the unused one", async () => {
    userFindUnique.mockResolvedValue({ locale: "en" });
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    const locales = new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { locale: string }).locale,
      ),
    );
    expect([...locales]).toEqual(["en"]);
  });

  it("does not blanket-evict general for an unrelated synced type", async () => {
    // A steps sample touches only the general overview, never the weight /
    // pulse / bp scopes — the constant Apple-Health sync must not thrash
    // every card's cache.
    await invalidateStatusInsightsForTypes("u1", ["ACTIVITY_STEPS"]);
    expect(deletedScopes()).toEqual(["general", "metric:STEPS"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:STEPS"]);
  });

  it("re-warms the matching generic metric scope for a registered type", async () => {
    // v1.8.7.1 — a blood-glucose sample dirties the general overview AND
    // its own generic assessment card (`metric:BLOOD_GLUCOSE`), so the
    // freshly-synced metric's card refreshes in the background instead of
    // lagging until the nightly warm pass.
    await invalidateStatusInsightsForTypes("u1", ["BLOOD_GLUCOSE"]);
    expect(deletedScopes()).toEqual(["general", "metric:BLOOD_GLUCOSE"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:BLOOD_GLUCOSE"]);
  });

  it("maps a remapped MeasurementType to its registry metric id", async () => {
    // ACTIVE_ENERGY_BURNED is stored under that DB type but the generic
    // metric id (route param + cache scope) is ACTIVE_ENERGY.
    await invalidateStatusInsightsForTypes("u1", ["ACTIVE_ENERGY_BURNED"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:ACTIVE_ENERGY"]);
  });

  it("does not emit a generic scope for an unregistered type", async () => {
    // A weight sample feeds weight + bmi + general; WEIGHT is one of the
    // seven specialised metrics and has no generic registry entry, so no
    // `metric:` scope is enqueued.
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(
      enqueuedScopes().some((s) => s.startsWith("metric:")),
    ).toBe(false);
  });
});
