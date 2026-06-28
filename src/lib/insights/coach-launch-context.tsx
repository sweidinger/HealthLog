"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";

/**
 * v1.4.27 R3d MB4 — Coach launch context.
 *
 * Until v1.4.27 the Coach drawer was mounted inline on
 * `/insights/page.tsx` body, which meant navigating to a routed
 * sub-page (`/insights/blood-pressure`, etc.) unmounted the drawer and
 * removed every entry point to the Coach. The MA3 audit + Decision F
 * promoted the drawer up to `/insights/layout.tsx` so every routed
 * Insights surface can launch it.
 *
 * Shape:
 *   - `<CoachLaunchProvider>` owns the drawer's open / prefill state
 *     and renders the children beneath the launch surface.
 *   - `useCoachLaunch()` returns `{ open, askCoach, setOpen, prefill }`
 *     so any descendant can open the drawer with an optional prefill
 *     string (the hero-strip suggested-prompt chips feed prefills;
 *     the sticky `<CoachLaunchButton>` opens without one).
 *
 * The provider is intentionally tiny — the actual drawer mount sits
 * next to it in the layout, reading the same state via the hook.
 */
export interface CoachLaunchScope {
  /**
   * Optional metric the user is looking at when they open the Coach.
   *
   * v1.4.28 R3c (BK-MED-2 / BK-F-M4) — narrowed from `string` to the
   * `CoachScopeSource` union so call sites cannot drift to a free-form
   * label that the sources rail then silently ignores. Adding a new
   * Apple-Health source to the rail (the union already covers the
   * v1.4.23 additions) automatically widens the allowed values here.
   *
   * v1.21.0 (C4 H1/H4) — now LIVE: the scope threads through the drawer
   * into the chat request so a conversation opened from a metric surface
   * or an insight card is pre-narrowed to the relevant source(s). The
   * `void scope` discard is gone.
   */
  metric?: CoachScopeSource;
  /**
   * Optional extra sources to include alongside `metric` — a correlation
   * card spanning two metrics (e.g. weight × pulse) seeds both so the
   * snapshot the Coach reads covers the relationship the card describes.
   */
  also?: CoachScopeSource[];
  /**
   * Optional day-window the conversation should anchor on. Defaults to
   * the chat route's own `last30days` when omitted.
   */
  window?: CoachScopeWindow;
}

interface CoachLaunchValue {
  /** Whether the Coach drawer is currently open. */
  open: boolean;
  /** Current prefill string (or null when the next open should start blank). */
  prefill: string | null;
  /**
   * When true, the opened conversation auto-sends the prefill as its first
   * turn (exactly once), so a card's "ask about this" hand-off lands the
   * answer directly instead of only seeding the composer. Cleared on close.
   */
  autoSend: boolean;
  /**
   * Scope the next/open conversation is narrowed to (or null for the
   * default all-source snapshot). Set by `askCoach(prefill, scope)`, or
   * inherited from the page's ambient scope when the FAB opens without an
   * explicit one. `<LayoutCoachMount>` forwards it to the drawer.
   */
  scope: CoachLaunchScope | null;
  /**
   * Open the drawer with an optional prefill + scope hint. When `autoSend`
   * is true the prefill is dispatched as the conversation's first turn
   * automatically (used by the assessment hand-off).
   */
  askCoach: (
    prefill?: string | null,
    scope?: CoachLaunchScope,
    autoSend?: boolean,
  ) => void;
  /**
   * v1.21.0 (C4 H1) — register the metric surface the user is currently
   * looking at so the global FAB (which calls `askCoach()` with no args)
   * still opens the Coach pre-scoped to that page. The optional
   * `seedPrefill` is the composer opener the FAB seeds when it inherits
   * this ambient scope. Returns a cleanup that clears the ambient scope; a
   * metric page calls it from an effect so the scope lifts when the user
   * navigates away. This keeps the FAB the single app-wide entry point
   * (CCH-04) while making it contextual.
   */
  registerScope: (
    scope: CoachLaunchScope,
    seedPrefill?: string | null,
  ) => () => void;
  /**
   * Direct setter for the open state — the drawer's `onOpenChange`
   * consumes it on close. Kept (rather than collapsed into a
   * `closeCoach()` helper) because `<LayoutCoachMount>` forwards the
   * raw setter to the Sheet's controlled-state contract, which expects
   * a boolean callback. v1.4.28 R3c (BK-F-M4) audit: exactly one
   * consumer, no drift.
   */
  setOpen: (next: boolean) => void;
}

const CoachLaunchContext = createContext<CoachLaunchValue | null>(null);

export interface CoachLaunchProviderProps {
  children: ReactNode;
}

export function CoachLaunchProvider({ children }: CoachLaunchProviderProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  // Whether the next open auto-sends its prefill as the first turn.
  const [autoSend, setAutoSend] = useState<boolean>(false);
  // Scope the open conversation is narrowed to. `null` → default snapshot.
  const [scope, setScope] = useState<CoachLaunchScope | null>(null);
  // Ambient scope + seed opener of the metric surface currently on screen.
  // The FAB's `askCoach()` (no args) falls back to these so opening the
  // Coach from a metric page still lands a pre-scoped, pre-seeded
  // conversation without re-adding a per-metric header icon (CCH-04). Refs,
  // not state — registering must not re-render the provider's subtree.
  const ambientScopeRef = useRef<CoachLaunchScope | null>(null);
  const ambientPrefillRef = useRef<string | null>(null);

  const askCoach = useCallback(
    (
      nextPrefill?: string | null,
      nextScope?: CoachLaunchScope,
      nextAutoSend?: boolean,
    ) => {
      // v1.21.0 (C4 H1/H4) — scope is live. An explicit scope (insight
      // card, metric-card affordance) wins; otherwise inherit the metric
      // page's ambient scope so the FAB opens contextual to where the user
      // is. `null` only when neither is present (true global launch). The
      // composer seed follows the same precedence: explicit prefill, else
      // the ambient page opener that pairs with the inherited scope.
      const usingAmbientScope = nextScope === undefined;
      setScope(nextScope ?? ambientScopeRef.current ?? null);
      setPrefill(
        nextPrefill ??
          (usingAmbientScope ? ambientPrefillRef.current : null) ??
          null,
      );
      // Auto-send only applies when an explicit prefill is given (a card
      // hand-off), never for an ambient/blank open.
      setAutoSend(Boolean(nextAutoSend) && Boolean(nextPrefill));
      setOpen(true);
    },
    [],
  );

  const registerScope = useCallback(
    (next: CoachLaunchScope, seedPrefill?: string | null) => {
      ambientScopeRef.current = next;
      ambientPrefillRef.current = seedPrefill ?? null;
      return () => {
        // Only clear if this registration is still the active one — guards
        // against a fast route change where the next page registers before
        // the previous page's cleanup runs.
        if (ambientScopeRef.current === next) {
          ambientScopeRef.current = null;
          ambientPrefillRef.current = null;
        }
      };
    },
    [],
  );

  const handleSetOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      // Drop the prefill + scope + auto-send on close so the next open
      // starts clean.
      setPrefill(null);
      setScope(null);
      setAutoSend(false);
    }
  }, []);

  const value = useMemo<CoachLaunchValue>(
    () => ({
      open,
      prefill,
      autoSend,
      scope,
      askCoach,
      registerScope,
      setOpen: handleSetOpen,
    }),
    [open, prefill, autoSend, scope, askCoach, registerScope, handleSetOpen],
  );

  return (
    <CoachLaunchContext.Provider value={value}>
      {children}
    </CoachLaunchContext.Provider>
  );
}

/**
 * Read the Coach launch context. Returns `null` when called outside a
 * `<CoachLaunchProvider>` so consumer components can degrade gracefully
 * (e.g. the hero strip's "Ask the coach" action stays disabled until
 * the provider mounts).
 */
export function useCoachLaunch(): CoachLaunchValue | null {
  return useContext(CoachLaunchContext);
}
