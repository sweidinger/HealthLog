# Security Policy

## Supported Versions

Only the latest release on the `main` branch is actively supported with security updates.

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, send an email to **security@bombeck.io** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgement**: Within 72 hours
- **Initial assessment**: Within 1 week
- **Fix and disclosure**: Coordinated with reporter, typically within 30 days

## Scope

The following are in scope:

- Authentication and session management
- Data encryption and secret handling
- API authorization and access control
- Cross-site scripting (XSS), CSRF, and injection vulnerabilities
- Information disclosure

Out of scope:

- Denial of service attacks
- Social engineering
- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the server

## Security Architecture

HealthLog is designed with security as a core principle:

- **Passkey-first authentication** (WebAuthn/FIDO2) with password fallback
- **AES-256-GCM encryption** for all stored secrets (OAuth tokens, API keys, VAPID keys)
- **Argon2id** password hashing with zxcvbn strength validation
- **HMAC-SHA256** hashed API tokens
- **Server-side sessions** in PostgreSQL (HttpOnly, SameSite=Strict, 30-day sliding expiry)
- **Rate limiting** on authentication and external-facing endpoints
- **Security headers**: CSP with nonces, HSTS, X-Frame-Options DENY, Permissions-Policy
- **Proxy-level route protection** via `proxy.ts` (session cookie validation on all non-public paths)

For more details, see the [security documentation](https://docs.healthlog.dev/security/overview/).
