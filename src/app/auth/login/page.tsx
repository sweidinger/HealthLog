"use client";

import { useId, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Loader2 } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { describePasskeyError } from "@/lib/passkey-errors";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // v1.4.27 MB3 — explicit error-region id so the email + password
  // inputs reference the banner via `aria-describedby`. Screen readers
  // pair the error with the field instead of announcing it as a
  // standalone alert detached from the form.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;
  const { data: registrationEnabled } = useQuery({
    queryKey: queryKeys.authRegistrationStatus(),
    queryFn: async () => {
      try {
        const data = await apiGet<{ registrationEnabled?: boolean }>(
          "/api/auth/registration-status",
          { cache: "no-store" },
        );
        return Boolean(data?.registrationEnabled ?? true);
      } catch {
        // Fail open, exactly as the raw `if (!res.ok) return true` did.
        return true;
      }
    },
    staleTime: 60 * 1000,
  });

  function getRedirectTarget(): string {
    const next = searchParams.get("next");
    if (!next) return "/";
    // Prevent open redirects: only allow local absolute paths.
    if (next.startsWith("/") && !next.startsWith("//")) {
      return next;
    }
    return "/";
  }

  async function handlePasskeyLogin() {
    setError(null);
    setLoading(true);

    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/passkey/login-options");

      const credential = await startAuthentication({ optionsJSON: options });

      await apiPost("/api/auth/passkey/login-verify", {
        challengeId,
        credential,
      });

      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push(getRedirectTarget());
    } catch (err) {
      // Route rejections carry the envelope error verbatim; everything
      // else (WebAuthn ceremony failures) keeps the descriptive mapping.
      if (err instanceof ApiError) {
        setError(err.message || t("auth.loginFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setError(t(key, params));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await apiPost("/api/auth/login", { email, password });

      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push(getRedirectTarget());
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : t("auth.loginFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      {/* v1.4.27 MB7 / CF-61 — drop `p-8` to `p-6 sm:p-8` so the
          auth card breathes on Galaxy Fold / Pixel 5 without stealing
          half the visible viewport with padding. Tablet+ keeps the
          generous 32 px padding. */}
      <div className="border-border bg-card rounded-xl border p-6 shadow-lg shadow-black/20 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">HealthLog</h1>
          </div>
        </div>

        <div className="mt-8 space-y-4">
          {/* Phase A5 / B-mobile: bumped from default size (h-9, 36px)
              to size="lg" so the login CTAs meet WCAG 2.5.5 (44px
              minimum) on mobile. Login is the most-tapped flow on a
              fresh install. */}
          <Button
            onClick={handlePasskeyLogin}
            className="min-h-11 w-full"
            size="lg"
            disabled={loading}
          >
            {loading && mode === "passkey" ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {t("auth.loginWithPasskey")}
          </Button>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">
              {t("common.or")}
            </span>
            <Separator className="flex-1" />
          </div>

          {mode === "passkey" ? (
            <Button
              variant="outline"
              className="min-h-11 w-full"
              size="lg"
              onClick={() => setMode("password")}
            >
              <Lock className="h-4 w-4" />
              {t("auth.loginWithPassword")}
            </Button>
          ) : (
            <form onSubmit={handlePasswordLogin} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="email">{t("auth.emailOrUsername")}</Label>
                <Input
                  id="email"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  inputMode="email"
                  enterKeyHint="next"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-required="true"
                  aria-invalid={!!error || undefined}
                  aria-describedby={errorDescriptor}
                  placeholder={t("auth.emailOrUsernamePlaceholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("auth.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  enterKeyHint="go"
                  aria-required="true"
                  aria-invalid={!!error || undefined}
                  aria-describedby={errorDescriptor}
                  placeholder="********"
                />
              </div>
              <Button
                type="submit"
                className="min-h-11 w-full"
                size="lg"
                disabled={loading}
              >
                {loading && mode === "password" ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
                {t("auth.login")}
              </Button>
              <button
                type="button"
                onClick={() => setMode("passkey")}
                className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-full items-center justify-center text-center text-xs"
              >
                {t("auth.backToPasskey")}
              </button>
            </form>
          )}

          {error && (
            <div
              id={errorId}
              role="alert"
              aria-live="polite"
              className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
            >
              {error}
            </div>
          )}

          {registrationEnabled === true && (
            <p className="text-muted-foreground text-center text-xs">
              {t("auth.noAccount")}{" "}
              <Link
                href="/auth/register"
                // axe-core `link-in-text-block` requires a visible
                // distinction beyond colour alone (WCAG 1.4.1). Forcing
                // the underline always-on instead of `hover:underline`
                // satisfies the rule without changing the visual after
                // hover.
                className="text-primary underline"
              >
                {t("auth.register")}
              </Link>
            </p>
          )}
        </div>
      </div>
      {/* v1.4.26 — discoverable privacy link below the login card.
          App Store reviewers and first-time visitors need a one-click
          path to the policy without signing in. */}
      <p className="text-muted-foreground text-center text-xs">
        <Link
          href="/privacy"
          className="hover:text-foreground underline underline-offset-2"
        >
          {t("auth.privacyPolicy")}
        </Link>
      </p>
    </div>
  );
}
