/**
 * Structural guards on the step-up elevation boundary.
 *
 * An elevation lets a Bearer token reach a surface that is otherwise
 * cookie-only. That is a deliberate, narrow widening, and its entire safety
 * argument rests on the set of routes it can unlock being small, known, and
 * unable to grow by accident. Behavioural tests prove the mechanism works;
 * these prove nobody quietly pointed it somewhere else.
 *
 * Like the Bearer-scope guards next door, these are tripwires rather than
 * proofs. They cannot show the allowlist is correct — only that it has not
 * changed without someone editing this file, which is where the reviewer's
 * attention is supposed to land.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { globSync } from "node:fs";

const SRC = join(process.cwd(), "src");

function sourceFiles(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .filter(
      (p) => !p.startsWith(`generated${sep}`) && !p.startsWith("generated/"),
    )
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => p.split(sep).join("/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

/**
 * Every route an elevation can unlock. This is the whole set — the second-factor
 * management surface and nothing besides.
 *
 * What is deliberately ABSENT is as much the point as what is present:
 *   - every `/api/admin/*` route. `requireAdmin` is cookie-only and does not
 *     consult this mechanism at all;
 *   - the trusted-device routes. "Remember this browser" is a browser concept;
 *     a native client has no equivalent to manage;
 *   - `requireFreshMfaIfEnrolled`'s callers (password change, account deletion,
 *     data reset, encrypted export, encryption-key rotation). Those are
 *     destructive account actions, not second-factor management, and letting an
 *     elevation satisfy them would be exactly the silent widening this file
 *     exists to prevent.
 */
const ELEVATION_ROUTES = [
  "app/api/auth/me/mfa/route.ts",
  "app/api/auth/me/mfa/disable/route.ts",
  "app/api/auth/me/mfa/recovery-codes/regenerate/route.ts",
  "app/api/auth/me/mfa/totp/confirm/route.ts",
  "app/api/auth/me/mfa/totp/setup/route.ts",
  "app/api/auth/me/mfa/webauthn/[id]/route.ts",
  "app/api/auth/me/mfa/webauthn/register/options/route.ts",
  "app/api/auth/me/mfa/webauthn/register/verify/route.ts",
].sort();

describe("S1 — the elevation-accepting route set is frozen", () => {
  it("only the known MFA-management routes call the gate", () => {
    const callers = filesMatching(/requireMfaManagementAuth\(/).filter(
      // The gate's own definition names itself.
      (rel) => rel !== "lib/api-handler.ts",
    );
    expect(callers).toEqual(ELEVATION_ROUTES);
  });

  it("no admin route calls the gate", () => {
    const admin = filesMatching(/requireMfaManagementAuth\(/).filter((rel) =>
      rel.startsWith("app/api/admin/"),
    );
    expect(admin).toEqual([]);
  });

  it("the old cookie-only gates no longer linger on the MFA surface", () => {
    // A route that still called `requireCookieAuth` / `requireFreshMfa`
    // directly would be outside the single gate, so its posture could drift
    // from the rest of the set without tripping the allowlist above.
    for (const rel of ELEVATION_ROUTES) {
      const src = read(rel);
      expect(src).not.toMatch(/await requireCookieAuth\(/);
      expect(src).not.toMatch(/await requireFreshMfa\(/);
    }
  });
});

describe("S2 — redemption happens in exactly one place", () => {
  it("only the gate redeems an elevation", () => {
    const redeemers = filesMatching(/redeemStepUpElevation\(/).filter(
      (rel) => rel !== "lib/auth/step-up.ts",
    );
    expect(redeemers).toEqual(["lib/api-handler.ts"]);
  });

  it("only the mint route mints one", () => {
    const minters = filesMatching(/mintStepUpElevation\(/).filter(
      (rel) => rel !== "lib/auth/step-up.ts",
    );
    expect(minters).toEqual(["app/api/auth/step-up/route.ts"]);
  });

  it("no route reads the elevation header for itself", () => {
    // The header is the gate's private input. A route reading it directly
    // would be hand-rolling an authorisation decision outside the one place
    // that is reviewed for it.
    const readers = sourceFiles()
      .filter((p) => p.endsWith("/route.ts"))
      .filter((rel) => /["']x-step-up["']/i.test(read(rel)));
    expect(readers).toEqual([]);
  });
});

describe("S3 — requireAdmin stays cookie-only", () => {
  it("resolves through getSession and nothing else", () => {
    const src = read("lib/api-handler.ts");
    const body = src.slice(
      src.indexOf("export async function requireAdmin("),
      src.indexOf("export async function requireCookieAuth("),
    );
    expect(body).toContain("await getSession()");
    // No Bearer resolution, and no elevation redemption, inside the admin gate.
    expect(body).not.toMatch(/authenticateBearer|resolveBearerToken/);
    expect(body).not.toMatch(/redeemStepUpElevation|STEP_UP_ELEVATION_HEADER/);
  });
});

describe("S4 — the mint surface refuses a cookie", () => {
  it("both step-up routes resolve via requireBearerAuth only", () => {
    for (const rel of [
      "app/api/auth/step-up/route.ts",
      "app/api/auth/step-up/options/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/await requireBearerAuth\(\)/);
      expect(src).not.toMatch(/requireAuth\(|requireCookieAuth\(/);
    }
  });

  it("requireBearerAuth never consults the session cookie", () => {
    const src = read("lib/api-handler.ts");
    const body = src.slice(
      src.indexOf("export async function requireBearerAuth("),
      src.indexOf("export const STEP_UP_ELEVATION_HEADER"),
    );
    expect(body).not.toContain("getSession(");
  });
});
