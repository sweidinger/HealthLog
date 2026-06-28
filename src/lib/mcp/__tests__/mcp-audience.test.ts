/**
 * Guard: the resource-server audience binding (H1). An MCP-audience token
 * (`health:read`, or `health:read health:write`) is bound to the `/mcp`
 * surface and refused on every REST write — a `health:write` MCP token can
 * never become a general REST write credential. A wildcard or any broader /
 * legacy grant is NOT audience-bound and keeps its existing reach.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { isMcpAudienceToken } from "@/lib/api-handler";

describe("isMcpAudienceToken", () => {
  it("read-only token IS audience-bound", () => {
    expect(isMcpAudienceToken(["health:read"])).toBe(true);
  });
  it("read+write token IS audience-bound (writes confined to /mcp)", () => {
    expect(isMcpAudienceToken(["health:read", "health:write"])).toBe(true);
  });
  it("write-only token IS audience-bound", () => {
    expect(isMcpAudienceToken(["health:write"])).toBe(true);
  });
  it("wildcard token is NOT audience-bound (keeps its reach)", () => {
    expect(isMcpAudienceToken(["*"])).toBe(false);
  });
  it("a mixed legacy grant is NOT audience-bound", () => {
    expect(isMcpAudienceToken(["health:read", "medication:ingest"])).toBe(
      false,
    );
  });
  it("an empty scope set is NOT audience-bound", () => {
    expect(isMcpAudienceToken([])).toBe(false);
  });
});
