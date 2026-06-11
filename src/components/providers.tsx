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
import { AppSettingsProvider } from "@/components/app-settings-provider";
import { VersionPoller } from "@/components/version-poller";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import { prefetchDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";

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
  }, [pathname, queryClient]);
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
          <AppSettingsProvider>
            <DashboardSnapshotPreloader />
            {children}
            <Toaster position="bottom-right" richColors />
            <VersionPoller />
          </AppSettingsProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
