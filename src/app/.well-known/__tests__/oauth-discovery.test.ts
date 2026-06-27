/**
 * OAuth discovery documents — M1 fail-closed + non-cacheable.
 *
 * Without a pinned origin the documents would derive the issuer / endpoints /
 * audience from the Host header, so the routes 404. When configured they must
 * not be `public`-cacheable (a host-derived document keyed on path alone could
 * be served cross-tenant).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const PRM_URL = "https://health.example/.well-known/oauth-protected-resource";
const ASM_URL = "https://health.example/.well-known/oauth-authorization-server";

let GET_PRM: (r: Request) => Response;
let GET_ASM: (r: Request) => Response;

beforeEach(async () => {
  GET_PRM = (await import("../oauth-protected-resource/route")).GET;
  GET_ASM = (await import("../oauth-authorization-server/route")).GET;
});

afterEach(() => {
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("OAuth discovery — M1 origin config", () => {
  it("404s the PRM when no origin is configured", () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = GET_PRM(new Request(PRM_URL));
    expect(res.status).toBe(404);
  });

  it("404s the AS metadata when no origin is configured", () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = GET_ASM(new Request(ASM_URL));
    expect(res.status).toBe(404);
  });

  it("serves the PRM with private/no-store when configured", async () => {
    process.env.APP_URL = "https://health.example";
    const res = GET_PRM(new Request(PRM_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.resource).toBe("https://health.example/mcp");
  });

  it("serves the AS metadata with private/no-store when configured", async () => {
    process.env.APP_URL = "https://health.example";
    const res = GET_ASM(new Request(ASM_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.issuer).toBe("https://health.example");
  });
});
