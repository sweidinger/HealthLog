"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { Toaster } from "@/components/ui/sonner";
import { VersionPoller } from "@/components/version-poller";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import { prefetchDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { prefetchMedicationsList } from "@/lib/queries/prefetch-medications";
import {
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";

const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

// ── Theme Context ────────────────────────────────────

type Theme = "dark" | "light" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: "dark" | "light") {
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(resolved);
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem("healthlog-theme") as Theme | null;
    // A stored "light"/"dark"/"system" choice wins. With no stored
    // preference the app defaults to dark rather than tracking the OS.
    if (saved === "light" || saved === "dark") return saved;
    if (saved === "system") return "system";
    return "dark";
  });

  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem("healthlog-theme") as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
    if (saved === "system") return getSystemTheme();
    return "dark";
  });

  // Apply theme on mount (inline script handles FOUC, this ensures classes are in sync)
  useEffect(() => {
    applyTheme(resolvedTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for OS preference changes when in system mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const resolved = e.matches ? "dark" : "light";
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    // Persist every explicit choice, including "system" — the absence of a
    // stored value is reserved for a fresh visitor and now defaults to dark.
    // Storing "system" verbatim keeps an explicit OS-tracking choice
    // distinguishable from "never chose", so a reload honours it.
    localStorage.setItem("healthlog-theme", next);
    if (next === "system") {
      const resolved = getSystemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    } else {
      setResolvedTheme(next);
      applyTheme(next);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ── Dashboard snapshot preloader ─────────────────────
//
// v1.16.6 first-load waterfall fix: fire the snapshot fetch the moment
// the router commits to "/" instead of waiting for the dashboard page
// chunk to download + mount (~450 ms later on a 4G / 4x-CPU profile).
// The proxy has already enforced auth + onboarding for "/" before any
// client code runs here, so the prefetch cannot fire for an
// unauthenticated visitor; a racing edge case just yields a swallowed
// 401 prefetch and the mounted cell re-resolves normally.
function DashboardSnapshotPreloader() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/" && isDashboardSnapshotEnabled()) {
      prefetchDashboardSnapshot(queryClient);
    }
    // v1.16.7 — same waterfall cut for the medications page: its list
    // query (which carries the per-medication `nextDueAt` the due cells
    // render) used to fire only after the page chunk mounted. Firing it
    // at route commit rides the data hop in parallel with the chunk
    // download; the nav links additionally prefetch on hover/touch
    // intent, so this is the fallback for direct loads + reloads.
    if (pathname === "/medications") {
      prefetchMedicationsList(queryClient);
    }
  }, [pathname, queryClient]);
  return null;
}

// ── Offline query persistence ────────────────────────
//
// v1.18.6 — hydrate the last-synced query cache from IndexedDB before the
// first authenticated paint, then debounce-persist successful reads back.
// Combined with the service worker's allowlisted stale-while-revalidate API
// branch, an installed PWA opened offline renders last-known data instead of
// empty skeletons. Build-version + age gated; cleared on logout.
function QueryPersistenceBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void restorePersistedQueryCache(queryClient, SHELL_VERSION).finally(() => {
      if (!cancelled) {
        stop = startPersistingQueryCache(queryClient, SHELL_VERSION);
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
  return null;
}

// ── Root Providers ───────────────────────────────────

export function Providers({
  children,
  initialLocale,
  initialMessages,
}: {
  children: ReactNode;
  initialLocale?: Locale;
  /** Active locale's bundle, server-resolved by the root layout (RSC handoff). */
  initialMessages?: Record<string, unknown>;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider
          initialLocale={initialLocale}
          initialMessages={initialMessages}
        >
          <QueryPersistenceBridge />
          <DashboardSnapshotPreloader />
          {children}
          <Toaster position="bottom-right" richColors />
          <VersionPoller />
          <ServiceWorkerRegistrar />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
