import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => false,
}));

import { proxy } from "../proxy";

function request(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("worker-only process HTTP boundary", () => {
  it("allows the process-aware health endpoint through", () => {
    const response = proxy(request("/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-HealthLog-Process-Type")).toBeNull();
  });

  it("continues to refuse non-health HTTP traffic", () => {
    const response = proxy(request("/api/version"));

    expect(response.status).toBe(503);
    expect(response.headers.get("X-HealthLog-Process-Type")).toBe("worker");
  });
});
