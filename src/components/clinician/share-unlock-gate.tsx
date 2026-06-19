"use client";

/**
 * v1.18.7 — passphrase gate for a protected clinician share link.
 *
 * Renders ONLY when the server determined the link carries a passphrase and the
 * short-lived unlock cookie is absent. The record is never sent to the client
 * until the cookie is set — this island is the whole page until then.
 *
 * Two paths:
 *   - The owner shares a QR / deep link carrying `#k=<passphrase>` in the URL
 *     FRAGMENT (never sent to the server). On mount we read `location.hash`,
 *     auto-submit it, scrub the hash from history, and reload on success so the
 *     server re-renders the record with the now-set cookie.
 *   - No fragment → a localised passphrase input the clinician types into.
 *
 * The submit POSTs to `/api/c/<token>/unlock`; on success the server has set an
 * httpOnly cookie scoped to this token's path, so a full reload paints the
 * record. Failure shows one blunt localised error (the server leaks nothing).
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api/api-fetch";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface ShareUnlockGateProps {
  t: Translate;
  /** The raw `hls_` token from the path — used only to build the verify URL. */
  token: string;
}

export function ShareUnlockGate({ t, token }: ShareUnlockGateProps) {
  const [passphrase, setPassphrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const autoTried = useRef(false);

  async function submit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    setPending(true);
    setError(false);
    try {
      await apiPost(`/api/c/${encodeURIComponent(token)}/unlock`, {
        passphrase: trimmed,
      });
      // Cookie is set server-side; a full reload re-renders with the record.
      window.location.reload();
    } catch {
      setError(true);
      setPending(false);
    }
  }

  // Auto-unlock from the `#k=<passphrase>` fragment, once.
  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const k = params.get("k");
    if (k) {
      // Scrub the secret from the address bar / history before the request.
      history.replaceState(null, "", window.location.pathname);
      // Defer out of the effect body so the submit's setState does not run
      // synchronously inside the effect (no cascading render).
      queueMicrotask(() => void submit(k));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <form
        className="space-y-4 rounded-lg border border-border bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(passphrase);
        }}
      >
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">
            {t("clinicianView.unlock.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("clinicianView.unlock.description")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="share-passphrase">
            {t("clinicianView.unlock.label")}
          </Label>
          <Input
            id="share-passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={error}
            className="font-mono"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t("clinicianView.unlock.error")}
          </p>
        )}

        <Button
          type="submit"
          disabled={pending || !passphrase.trim()}
          className="min-h-11 w-full sm:min-h-9"
        >
          {t("clinicianView.unlock.submit")}
        </Button>
      </form>
    </main>
  );
}
