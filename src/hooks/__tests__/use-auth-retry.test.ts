/**
 * v1.16.8 — the auth cell retries ONCE on transient failures.
 *
 * `useAuth` used to pin `retry: false`, so one transient network blip
 * on `/api/auth/me` flipped `isAuthenticated` false and sent the shell
 * to the redirect spinner mid-session. The cell now uses the shared
 * transient-retry predicate: one retry on network errors / 5xx, never
 * on 401/403 (those are real answers).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn<(opts: Record<string, unknown>) => { data: undefined }>(
  () => ({ data: undefined }),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: Record<string, unknown>) => useQueryMock(opts),
  useQueryClient: () => ({}),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

import { useAuth } from "../use-auth";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import { queryKeys } from "@/lib/query-keys";

afterEach(() => {
  useQueryMock.mockClear();
});

describe("useAuth — transient-retry softening", () => {
  it("routes retry through the shared transient predicate", () => {
    useAuth();
    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const opts = useQueryMock.mock.calls[0]![0];
    expect(opts.retry).toBe(retryOnceOnTransientError);
    expect(opts.queryKey).toEqual(queryKeys.authMe());
  });
});
