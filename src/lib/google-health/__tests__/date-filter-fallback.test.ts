/**
 * Pins the daily-summary `.date` filter contract in `fetchDataPoints`.
 *
 * The official docs contradict themselves on the type-name prefix inside a
 * daily-summary filter: the data-types index's "filter parameter" column says
 * snake_case (`daily_resting_heart_rate`), while the `dataPoints.list`
 * reference's only worked daily example is camelCase
 * (`dailyHeartRateVariability.date < "2024-08-15"`). The client sends the
 * worked-example camelCase form first and retries the whole walk once with
 * snake_case if the VERY FIRST request 400s. Sample/session/sleep filters have
 * a single documented grammar and never fall back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

import { GOOGLE_HEALTH_DATA_TYPES, fetchDataPoints } from "../client";
import { GoogleHealthApiError } from "../response-classifier";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** The decoded `filter` query parameter of the n-th captured request. */
function capturedFilter(n: number): string | null {
  const url = safeFetchMock.mock.calls[n]?.[0] as string;
  return new URL(url).searchParams.get("filter");
}

const start = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  safeFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchDataPoints — daily-summary filter style", () => {
  it("sends the camelCase worked-example prefix first", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        dataPoints: [{ dailyRestingHeartRate: { beatsPerMinute: "54" } }],
      }),
    );

    const styles: string[] = [];
    const points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
      "token",
      "fetchRhr",
      { start, onDateFilterStyle: (s) => styles.push(s) },
    );

    expect(points).toHaveLength(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(capturedFilter(0)).toBe(
      'dailyRestingHeartRate.date >= "2026-06-01"',
    );
    expect(styles).toEqual(["camel"]);
  });

  it("re-walks once with the snake_case prefix when the first page 400s", async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { status: "INVALID_ARGUMENT", message: "Invalid filter" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          dataPoints: [{ dailyRestingHeartRate: { beatsPerMinute: "54" } }],
        }),
      );

    const styles: string[] = [];
    const points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
      "token",
      "fetchRhr",
      { start, onDateFilterStyle: (s) => styles.push(s) },
    );

    expect(points).toHaveLength(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(capturedFilter(0)).toBe(
      'dailyRestingHeartRate.date >= "2026-06-01"',
    );
    expect(capturedFilter(1)).toBe(
      'daily_resting_heart_rate.date >= "2026-06-01"',
    );
    expect(styles).toEqual(["snake"]);
  });

  it("propagates a 400 on the snake retry (both grammars rejected)", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { status: "INVALID_ARGUMENT", message: "Invalid filter" },
      }),
    );

    await expect(
      fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.heartRateVariability,
        "token",
        "fetchHrv",
        { start },
      ),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a 400 past the first page without re-walking", async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { dataPoints: [], nextPageToken: "p2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { status: "INVALID_ARGUMENT", message: "boom" },
        }),
      );

    await expect(
      fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
        "token",
        "fetchRhr",
        { start },
      ),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("never falls back for a sample-type filter (single documented grammar)", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { status: "INVALID_ARGUMENT", message: "Invalid filter" },
      }),
    );

    await expect(
      fetchDataPoints(GOOGLE_HEALTH_DATA_TYPES.weight, "token", "fetchWeight", {
        start,
      }),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(capturedFilter(0)).toBe(
      'weight.sample_time.physical_time >= "2026-06-01T00:00:00.000Z"',
    );
  });

  it("never falls back on an unfiltered backfill walk (no filter to reshape)", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { status: "INVALID_ARGUMENT", message: "boom" },
      }),
    );

    await expect(
      fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
        "token",
        "fetchRhr",
      ),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(capturedFilter(0)).toBeNull();
  });
});
