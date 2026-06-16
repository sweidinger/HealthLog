/**
 * v1.18.0 — Settings → Module ("Was du trackst") hub contract.
 *
 * `<ModulesSection>` lists every toggleable module with a `<Switch>` bound
 * to the resolved module map (`useAuth().user.modules`), plus a read-only
 * "always on" group for the four core domains. Flipping a toggle PATCHes
 * `/api/auth/me/modules` (a DISABLED allowlist) and invalidates the
 * `authMe()` query so nav / pills / tiles re-gate live.
 *
 * Test strategy mirrors `advanced-research-mode.test.tsx`: mock
 * `@tanstack/react-query` so the rendered tree executes under SSR
 * (`renderToStaticMarkup`), capture the `useMutation` config to assert the
 * PATCH body + the `authMe()` invalidation directly, and mock `useAuth` to
 * drive the disabled-module case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import {
  MODULE_KEYS,
  CORE_DOMAIN_KEYS,
  moduleDelegatesTo,
} from "@/lib/modules/registry";

// Capture the latest useMutation config + a shared mutate spy so we can
// invoke `mutationFn` / `onSuccess` by hand (the SSR pass can't fire a
// real DOM click).
type MutationConfig = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data?: unknown) => void;
  onError?: (err?: unknown) => void;
};
let lastMutation: MutationConfig | null = null;
const mutateSpy = vi.fn();
const invalidateSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useMutation: (config: MutationConfig) => {
    lastMutation = config;
    return { mutate: mutateSpy, isPending: false };
  },
}));

const authSpy = vi.fn<() => { user: AuthUser | null; isAuthenticated: boolean }>(
  () => ({ user: buildUser({}), isAuthenticated: true }),
);
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

function buildUser(modules: AuthUser["modules"]): AuthUser {
  return {
    id: "user-1",
    username: "testuser",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    cycleTrackingEnabled: false,
    modules,
  };
}

import { ModulesSection } from "../modules-section";

function render(locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ModulesSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  lastMutation = null;
  mutateSpy.mockClear();
  invalidateSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser({}),
    isAuthenticated: true,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ModulesSection>", () => {
  it("renders a Switch for every non-delegated toggleable module, a managed deep-link for delegated ones, and locked switches for core", () => {
    const html = render();
    for (const key of MODULE_KEYS) {
      if (moduleDelegatesTo(key) !== undefined) {
        // Delegated modules (cycle/coach) are owned by their real control
        // elsewhere — they render as a read-only "manage in X" deep-link,
        // never a live Switch that would write an inert disabled-allowlist
        // entry the gate ignores.
        expect(html, `delegated has no switch ${key}`).not.toContain(
          `id="module-toggle-${key}"`,
        );
      } else {
        expect(html, `toggleable switch ${key}`).toContain(
          `id="module-toggle-${key}"`,
        );
      }
    }
    for (const key of CORE_DOMAIN_KEYS) {
      expect(html, `core switch ${key}`).toContain(`id="module-toggle-${key}"`);
    }
  });

  it("seeds an enabled module checked (default-on) and a disabled one unchecked", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser({ sleep: false }),
      isAuthenticated: true,
    }));
    const html = render();

    // The disabled `sleep` toggle surfaces data-state="unchecked".
    const sleepTag = html.match(
      /<button[^>]*id="module-toggle-sleep"[^>]*>/,
    )?.[0];
    expect(sleepTag).toBeDefined();
    expect(sleepTag).toMatch(/data-state="unchecked"/);

    // An absent key (`mood`) reads as enabled → checked.
    const moodTag = html.match(
      /<button[^>]*id="module-toggle-mood"[^>]*>/,
    )?.[0];
    expect(moodTag).toMatch(/data-state="checked"/);
  });

  it("renders the core domains locked (checked + disabled)", () => {
    const html = render();
    for (const key of CORE_DOMAIN_KEYS) {
      const tag = html.match(
        new RegExp(`<button[^>]*id="module-toggle-${key}"[^>]*>`),
      )?.[0];
      expect(tag, `core ${key}`).toBeDefined();
      expect(tag).toMatch(/data-state="checked"/);
      expect(tag).toMatch(/disabled/);
    }
  });

  it("PATCHes only the flipped key as a disabled-allowlist entry", async () => {
    render();
    expect(lastMutation?.mutationFn).toBeTypeOf("function");

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { modules: {} } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await lastMutation!.mutationFn!({ key: "glucose", enabled: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/auth/me/modules");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ glucose: false });
  });

  it("invalidates the authMe query on a successful toggle", () => {
    render();
    expect(lastMutation?.onSuccess).toBeTypeOf("function");

    lastMutation!.onSuccess!();

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.authMe(),
    });
  });
});
