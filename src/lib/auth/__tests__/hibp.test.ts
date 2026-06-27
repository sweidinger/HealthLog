import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ getEvent: () => null }));

import { checkPasswordBreach } from "../hibp";
import { safeFetch } from "@/lib/safe-fetch";

const PASSWORD = "correct horse battery staple";
const DIGEST = createHash("sha1")
  .update(PASSWORD, "utf8")
  .digest("hex")
  .toUpperCase();
const PREFIX = DIGEST.slice(0, 5);
const SUFFIX = DIGEST.slice(5);

function textResponse(body: string, ok = true): Response {
  return {
    ok,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkPasswordBreach — k-anonymity", () => {
  it("sends ONLY the 5-char prefix and never the full hash or suffix", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      textResponse(`${SUFFIX}:42\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9`),
    );

    await checkPasswordBreach(PASSWORD);

    const url = vi.mocked(safeFetch).mock.calls[0][0] as string;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    // The suffix and full digest must never leave the process.
    expect(url).not.toContain(SUFFIX);
    expect(url).not.toContain(DIGEST);
    // Only 5 hex chars after the range/ segment.
    const sent = url.split("/range/")[1];
    expect(sent).toHaveLength(5);
    expect(sent).toMatch(/^[0-9A-F]{5}$/);

    // Add-Padding header is set so the response size doesn't leak the bucket.
    const init = vi.mocked(safeFetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Add-Padding"]).toBe(
      "true",
    );
    // requirePublicHost is pinned.
    const opts = vi.mocked(safeFetch).mock.calls[0][2] as {
      requirePublicHost?: boolean;
    };
    expect(opts.requirePublicHost).toBe(true);
  });

  it("flags a breached password from a matching suffix", async () => {
    vi.mocked(safeFetch).mockResolvedValue(textResponse(`${SUFFIX}:1337`));
    const res = await checkPasswordBreach(PASSWORD);
    expect(res).toEqual({ breached: true, count: 1337 });
  });

  it("matches the suffix case-insensitively", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      textResponse(`${SUFFIX.toLowerCase()}:5`),
    );
    const res = await checkPasswordBreach(PASSWORD);
    expect(res?.breached).toBe(true);
  });

  it("reports not-breached when the suffix is absent", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      textResponse("0000000000000000000000000000000000A:3"),
    );
    const res = await checkPasswordBreach(PASSWORD);
    expect(res).toEqual({ breached: false, count: 0 });
  });

  it("fails open (null) on a non-200 response", async () => {
    vi.mocked(safeFetch).mockResolvedValue(textResponse("", false));
    expect(await checkPasswordBreach(PASSWORD)).toBeNull();
  });

  it("fails open (null) when the request throws (HIBP down)", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error("network"));
    expect(await checkPasswordBreach(PASSWORD)).toBeNull();
  });
});
