/**
 * Unit coverage for the TLS leaf SPKI pin helpers.
 *
 * The SPKI computation is pinned against a static self-signed fixture
 * certificate (RSA-2048, generated once with `openssl req -x509`). Its
 * known pin is `base64(sha256(DER subjectPublicKeyInfo))` — the iOS pin
 * convention. If the computation regresses (e.g. someone swaps in the raw
 * EC point / RSA key from `getPeerCertificate().pubkey`, which is NOT the
 * SPKI), this fixture catches it: the served-vs-pinned compare is the whole
 * alarm, so the hash must match Apple's byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import { createHash, X509Certificate } from "node:crypto";

import {
  spkiPinFromCertificate,
  parseKnownPins,
  isPinKnown,
  resolveAppTlsTarget,
} from "@/lib/tls/leaf-spki";

// Self-signed RSA-2048 leaf, CN=test.healthlog.example. Static fixture —
// its SPKI pin is deterministic and recorded below.
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUQuLHUZ5FLA5N96Qc6686X5uyh70wDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWdGVzdC5oZWFsdGhsb2cuZXhhbXBsZTAeFw0yNjA2MDUw
NTUzMjFaFw0zNjA2MDIwNTUzMjFaMCExHzAdBgNVBAMMFnRlc3QuaGVhbHRobG9n
LmV4YW1wbGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDhJFlWVLZC
rb/dVQltFOt1i1QWMRYLSRNXb5KL2XlAxDY3iTmalAwyss/Uh9PDXuavevtOhu/L
GNFoPdE2Y40WzLaJtmM+OagXzaZ2ZOEvhZjBn4yDI4y+6WuruHJ1KCi4777PGFFl
UiBKlGtcI1NyJbcGilrPV7a8YnAUYzbv7feTlVxg3td4d0fhzPCC7vgBORiaM8c7
xDvDkwF+38/Nmx2td6qjqtI+c4+HN4XF1jiVV227DU2hD/Oe056oL46qrj9W1psY
h5G8xSH2eWGOKlhoD3hnSDs8CwxZsEBaq3ky2k+JXARcbpxXKHj2FkNfcdnKDaTh
y7EGhHJSy17tAgMBAAGjUzBRMB0GA1UdDgQWBBTNRvThVPTH/b8p+bqILqP7ZPws
IjAfBgNVHSMEGDAWgBTNRvThVPTH/b8p+bqILqP7ZPwsIjAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQDVHga3RM+ACgDMdNtZ8R+kFo9/A3/LMkHF
0S2kI7ZqwDiZC7OhSac4sbFRR69fWwJfG6ORuYEWXExxnQpKOzEu91n8PURGC5CA
lRtPm3Oqoat7W6rtJuef9xzFXWsgsFPfVzWqCpYR727ketFeS2uo2Onm7tl3uZMk
C02Ev7XglT2r7qmyuY2R+BPmCqOK8YG5w9001KzyYHNTVlr5a9+6R22vLNh6mj/y
bPFU8Ozb1ze27ORT1CoRPhDfrU3+UzOvd1/ENfSFhyZ3SFI9BGV0ezt/hCUXsyLA
5vU8y43XR8vAQdGOF43har8K3S4Ijjy1ruaKjWFkCC0rjStJAt/f
-----END CERTIFICATE-----`;

const FIXTURE_PIN = "/W80wXNcE/ANQgZGEQK4grEcWul1vITYjPZ4HUvL090=";

describe("spkiPinFromCertificate", () => {
  it("computes the iOS pin from a PEM fixture", () => {
    expect(spkiPinFromCertificate(FIXTURE_CERT_PEM)).toBe(FIXTURE_PIN);
  });

  it("computes the same pin from an X509Certificate instance", () => {
    const x509 = new X509Certificate(FIXTURE_CERT_PEM);
    expect(spkiPinFromCertificate(x509)).toBe(FIXTURE_PIN);
  });

  it("computes the same pin from the DER bytes", () => {
    const x509 = new X509Certificate(FIXTURE_CERT_PEM);
    expect(spkiPinFromCertificate(x509.raw)).toBe(FIXTURE_PIN);
  });

  it("matches base64(sha256(DER subjectPublicKeyInfo)) — the iOS convention", () => {
    // Cross-check the pin against an independent computation off the DER
    // SPKI so the test pins the *meaning*, not just the recorded constant.
    const x509 = new X509Certificate(FIXTURE_CERT_PEM);
    const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
    const expected = createHash("sha256").update(spkiDer).digest("base64");
    expect(spkiPinFromCertificate(FIXTURE_CERT_PEM)).toBe(expected);
  });

  it("is base64 and 44 chars (32-byte SHA-256 digest)", () => {
    const pin = spkiPinFromCertificate(FIXTURE_CERT_PEM);
    expect(pin).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe("parseKnownPins", () => {
  it("returns an empty set for unset / empty baseline", () => {
    expect(parseKnownPins(undefined)).toEqual([]);
    expect(parseKnownPins(null)).toEqual([]);
    expect(parseKnownPins("")).toEqual([]);
    expect(parseKnownPins("   ")).toEqual([]);
  });

  it("parses a single pin", () => {
    expect(parseKnownPins(FIXTURE_PIN)).toEqual([FIXTURE_PIN]);
  });

  it("parses a comma-separated dual-pin window and trims whitespace", () => {
    const next = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK=";
    expect(parseKnownPins(`  ${FIXTURE_PIN} , ${next} `)).toEqual([
      FIXTURE_PIN,
      next,
    ]);
  });

  it("deduplicates repeated pins", () => {
    expect(parseKnownPins(`${FIXTURE_PIN},${FIXTURE_PIN}`)).toEqual([
      FIXTURE_PIN,
    ]);
  });
});

describe("isPinKnown — change detection", () => {
  const known = parseKnownPins(FIXTURE_PIN);

  it("treats the served pin as known when it is in the set (no alarm)", () => {
    expect(isPinKnown(FIXTURE_PIN, known)).toBe(true);
  });

  it("treats a rotated leaf pin as unknown (the alarm condition)", () => {
    const rotated = "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSSRRRRQQQQPPP=";
    expect(isPinKnown(rotated, known)).toBe(false);
  });

  it("treats any served pin as unknown when the baseline is empty", () => {
    expect(isPinKnown(FIXTURE_PIN, [])).toBe(false);
  });

  it("matches against any pin in a dual-pin window", () => {
    const next = "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSSRRRRQQQQPPP=";
    const dual = parseKnownPins(`${FIXTURE_PIN},${next}`);
    expect(isPinKnown(FIXTURE_PIN, dual)).toBe(true);
    expect(isPinKnown(next, dual)).toBe(true);
  });
});

describe("resolveAppTlsTarget", () => {
  it("prefers APP_URL over NEXT_PUBLIC_APP_URL", () => {
    expect(
      resolveAppTlsTarget(
        "https://app.example.com",
        "https://other.example.com",
      ),
    ).toEqual({ host: "app.example.com", port: 443 });
  });

  it("falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset", () => {
    expect(resolveAppTlsTarget(undefined, "https://pub.example.com")).toEqual({
      host: "pub.example.com",
      port: 443,
    });
  });

  it("honours an explicit https port", () => {
    expect(
      resolveAppTlsTarget("https://app.example.com:8443", undefined),
    ).toEqual({ host: "app.example.com", port: 8443 });
  });

  it("skips a plain-HTTP origin (no leaf to pin)", () => {
    expect(resolveAppTlsTarget("http://lan.local", undefined)).toBeNull();
  });

  it("skips a non-https candidate but uses the next https one", () => {
    expect(
      resolveAppTlsTarget("http://lan.local", "https://pub.example.com"),
    ).toEqual({ host: "pub.example.com", port: 443 });
  });

  it("returns null when nothing is configured", () => {
    expect(resolveAppTlsTarget(undefined, undefined)).toBeNull();
    expect(resolveAppTlsTarget("not a url", "also bad")).toBeNull();
  });
});
