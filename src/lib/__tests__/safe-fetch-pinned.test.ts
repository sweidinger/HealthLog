/**
 * End-to-end regression for the pinned (`requirePublicHost: true`) egress path.
 *
 * This is deliberately NOT a mocked-fetch test. The production bug it guards
 * against is a coupling between the fetch ENGINE and the undici dispatcher:
 *
 *  1. Version skew — handing an `undici@8` `Agent` to Node's built-in global
 *     `fetch` (backed by a different, internal undici copy) throws
 *     `UND_ERR_INVALID_ARG`. A mocked `fetch` would never surface this; only a
 *     real dispatch through the real fetch engine does. The fix routes the
 *     pinned path through undici's OWN `fetch`.
 *  2. Single-address pin — returning only the first resolved address made a
 *     host whose first record is an unreachable IPv6 fail instantly. The fix
 *     hands undici the full vetted set + enables Happy Eyeballs.
 *
 * To exercise the real transport against a localhost-bound server we stub the
 * two IP-classification predicates (so loopback is treated as dialable for the
 * harness) and `dns.lookup` (so the test hostname maps to the test server).
 * The dispatcher, the undici fetch engine, the connect, and the server are all
 * REAL — which is exactly what makes this catch the coupling bug.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import dns from "node:dns";
import type { AddressInfo } from "node:net";

// Treat every address/URL as public so the harness can reach a loopback server
// through the requirePublicHost guard. The transport coupling under test is
// orthogonal to IP classification (covered by safe-fetch-dispatcher.test.ts).
vi.mock("@/lib/validations/notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/validations/notifications")>();
  return {
    ...actual,
    isPublicIp: () => true,
    isPublicUrl: () => true,
  };
});

import { safeFetch, SafeFetchError } from "../safe-fetch";
import { _resetPinnedDispatcherForTests } from "../safe-fetch-dispatcher";

let server: http.Server;
let port: number;

function mockLookupTo(addresses: dns.LookupAddress[]): void {
  vi.spyOn(dns, "lookup").mockImplementation(((
    _hostname: string,
    _opts: dns.LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addrs: dns.LookupAddress[],
    ) => void,
  ) => {
    callback(null, addresses);
  }) as unknown as typeof dns.lookup);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("chunk-1;");
      setTimeout(() => {
        res.write("chunk-2;");
        res.end("chunk-3");
      }, 10);
      return;
    }
    if (req.url === "/hang") {
      // Never respond — drives the timeout path.
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetPinnedDispatcherForTests();
});

describe("safeFetch pinned path — real transport", () => {
  it("returns 200 end-to-end through the pinned dispatcher + undici fetch", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const res = await safeFetch(
      `http://pinned.test:${port}/api`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 20_000);

  it("falls back across families when the first address is a black-holed IPv6", async () => {
    // First record is an unreachable IPv6 (RFC 6666 discard prefix); the
    // working IPv4 record is behind it. Pre-fix this failed instantly; with
    // Happy Eyeballs the connect falls back to v4 and succeeds.
    mockLookupTo([
      { address: "0100::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const res = await safeFetch(
      `http://dualstack.test:${port}/api`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );

    expect(res.status).toBe(200);
  }, 20_000);

  it("streams a chunked response body via getReader() on the pinned path", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const res = await safeFetch(
      `http://pinned.test:${port}/stream`,
      {},
      { requirePublicHost: true, timeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    expect(out).toBe("chunk-1;chunk-2;chunk-3");
  }, 20_000);

  it("times out on the pinned path and maps to SafeFetchError kind 'timeout'", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      safeFetch(
        `http://pinned.test:${port}/hang`,
        {},
        { requirePublicHost: true, timeoutMs: 200 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  }, 20_000);

  it("honours a caller-supplied abort signal on the pinned path", async () => {
    mockLookupTo([{ address: "127.0.0.1", family: 4 }]);

    const controller = new AbortController();
    const pending = safeFetch(
      `http://pinned.test:${port}/hang`,
      { signal: controller.signal },
      { requirePublicHost: true, timeoutMs: 5000 },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SafeFetchError);
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  }, 20_000);
});
