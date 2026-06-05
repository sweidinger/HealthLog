/**
 * TLS leaf SubjectPublicKeyInfo (SPKI) pin helpers.
 *
 * The native iOS client SPKI-pins the server's TLS **leaf** certificate.
 * A pin is `base64(sha256(DER subjectPublicKeyInfo))` — the same value
 * Apple's `NSPinnedDomains` / a manual `SecTrust` SPKI check computes, and
 * the same value the HTTP `Public-Key-Pins` header used historically.
 *
 * When the leaf certificate auto-renews (e.g. Google Trust Services
 * re-issues it), the leaf keypair — and therefore the SPKI hash — changes.
 * A pinned client that has not been shipped the new pin will then refuse
 * to connect: a silent outage on the next renewal. There is no server-side
 * signal today that any client pins the served leaf, so this module lets a
 * scheduled job fail loudly the moment the served SPKI leaves the operator's
 * known-good set, giving the iOS release owner time to re-pin and ship a
 * TestFlight build before the old pin is gone.
 *
 * CORRECTNESS NOTE — why `X509Certificate.publicKey.export({spki})`, not
 * `tls.getPeerCertificate(true).pubkey`:
 *
 *   `getPeerCertificate(detailed).pubkey` is NOT the DER `subjectPublicKeyInfo`.
 *   For an EC leaf it is only the raw ~65-byte EC point; for RSA it is the
 *   bare `RSAPublicKey` SEQUENCE. Hashing it yields a value that does NOT
 *   match the iOS pin. We therefore parse `cert.raw` (the leaf DER) through
 *   `crypto.X509Certificate` and export the public key as `spki`/`der`, which
 *   is exactly the `subjectPublicKeyInfo` Apple hashes.
 */
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { createHash, X509Certificate } from "node:crypto";

/**
 * Compute the iOS SPKI pin for a leaf certificate supplied as DER bytes,
 * a `crypto.X509Certificate`, or a PEM string. Returns
 * `base64(sha256(DER subjectPublicKeyInfo))`.
 */
export function spkiPinFromCertificate(
  cert: Buffer | X509Certificate | string,
): string {
  const x509 =
    cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  // `spki` + `der` => the DER subjectPublicKeyInfo, the exact byte sequence
  // an iOS SPKI pin hashes. Do NOT substitute the raw EC point / RSA key.
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("base64");
}

/**
 * Parse the operator's known-good pin set from the env baseline.
 *
 * `TLS_LEAF_SPKI_PINS` is comma-separated so the operator can hold BOTH
 * the current leaf pin AND the next leaf pin during the dual-pin window
 * that precedes a renewal — exactly mirroring the pin set shipped to the
 * iOS app. An empty / unset value yields an empty set; the caller treats
 * that as "baseline not configured" (a loud no-op, never a silent
 * auto-adopt).
 */
export function parseKnownPins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const pin = part.trim();
    if (pin.length > 0) seen.add(pin);
  }
  return [...seen];
}

/**
 * Whether the served pin is in the operator's known-good set. A served pin
 * that is NOT in the set is the alarm condition — the leaf the iOS app
 * pins has rotated underneath the shipped pin set.
 */
export function isPinKnown(servedPin: string, knownPins: string[]): boolean {
  return knownPins.includes(servedPin);
}

/**
 * Derive the public host (and port) the iOS client connects to from the
 * app URL env. Prefers `APP_URL`, then `NEXT_PUBLIC_APP_URL` — the same
 * precedence the passkey origin resolver uses. Returns `null` when no
 * usable HTTPS URL is configured (plain-HTTP self-hosts have no leaf to
 * pin, so the monitor is a no-op there).
 */
export function resolveAppTlsTarget(
  appUrl: string | undefined = process.env.APP_URL,
  publicAppUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL,
): { host: string; port: number } | null {
  for (const candidate of [appUrl, publicAppUrl]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    // The iOS pin only matters for the TLS leaf; a plain-HTTP origin has
    // no certificate to pin, so we skip it rather than probing :80.
    if (url.protocol !== "https:") continue;
    const port = url.port ? Number(url.port) : 443;
    if (!Number.isFinite(port) || port <= 0) continue;
    return { host: url.hostname, port };
  }
  return null;
}

export interface LeafProbeResult {
  /** The iOS SPKI pin of the served leaf certificate. */
  pin: string;
  /** Leaf certificate validity end, ISO 8601, for the re-pin deadline. */
  validTo: string;
  /** SHA-256 fingerprint of the whole leaf cert, for cross-referencing. */
  fingerprint256: string;
}

/**
 * Open a raw TLS socket to `host:port`, read the served LEAF certificate,
 * and compute its iOS SPKI pin. Works regardless of how the reverse proxy
 * terminates TLS — we observe exactly the certificate a pinned client
 * would, because we speak TLS to the same public endpoint it does.
 *
 * `rejectUnauthorized: false` is deliberate: we are inspecting the served
 * leaf, not authenticating it. An expired / self-signed / chain-broken
 * cert is itself signal the operator wants surfaced, not a reason to abort
 * the probe before we can read the pin. The connection is read-only and
 * torn down the instant the certificate is in hand.
 */
export function fetchLeafSpki(
  host: string,
  port = 443,
  timeoutMs = 10_000,
): Promise<LeafProbeResult> {
  return new Promise<LeafProbeResult>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        // No ALPN / no app data — we only need the handshake's leaf cert.
      },
      () => {
        try {
          const cert: PeerCertificate = socket.getPeerCertificate(true);
          if (!cert || !cert.raw) {
            cleanup();
            reject(new Error("no peer certificate served"));
            return;
          }
          const x509 = new X509Certificate(cert.raw);
          const result: LeafProbeResult = {
            pin: spkiPinFromCertificate(x509),
            validTo: new Date(x509.validTo).toISOString(),
            fingerprint256: x509.fingerprint256,
          };
          cleanup();
          resolve(result);
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`TLS probe to ${host}:${port} timed out`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.destroy();
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    socket.once("error", onError);
  });
}
