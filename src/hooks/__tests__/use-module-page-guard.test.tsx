import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.18.0 B1 — `useModulePageGuard` is the client-side direct-URL guard
 * for the insights sub-pages of a toggleable module. The repo has no
 * `@testing-library/react`, so the contract is exercised through an SSR
 * Probe that renders the resolved `ready` flag. The redirect side-effect
 * lives in a `useEffect` (no-op under SSR); the `ready` derivation is the
 * load-bearing decision both the redirect and the loader branch read, so
 * locking it covers the guard.
 */
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const useAuthMock = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => useAuthMock(),
}));

import { useModulePageGuard } from "../use-module-page-guard";

function Probe({ moduleKey }: { moduleKey: "glucose" }) {
  const { ready } = useModulePageGuard(moduleKey);
  return <span data-testid="ready">{String(ready)}</span>;
}

function readyOf(): string {
  const html = renderToStaticMarkup(<Probe moduleKey="glucose" />);
  return html.includes(">true<") ? "true" : "false";
}

describe("useModulePageGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not ready while auth is loading", () => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: true,
      isAuthenticated: false,
    });
    expect(readyOf()).toBe("false");
  });

  it("is not ready when unauthenticated", () => {
    useAuthMock.mockReturnValue({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });
    expect(readyOf()).toBe("false");
  });

  it("is not ready when the module is disabled (explicit false)", () => {
    useAuthMock.mockReturnValue({
      user: { modules: { glucose: false } },
      isLoading: false,
      isAuthenticated: true,
    });
    expect(readyOf()).toBe("false");
  });

  it("is ready when authenticated and the module is enabled", () => {
    useAuthMock.mockReturnValue({
      user: { modules: { glucose: true } },
      isLoading: false,
      isAuthenticated: true,
    });
    expect(readyOf()).toBe("true");
  });

  it("is ready (default-on) when the module key is absent", () => {
    useAuthMock.mockReturnValue({
      user: { modules: {} },
      isLoading: false,
      isAuthenticated: true,
    });
    expect(readyOf()).toBe("true");
  });
});
