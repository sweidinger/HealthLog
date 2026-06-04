# WHOOP integration

HealthLog connects to WHOOP via OAuth2 plus HMAC-signed webhooks for
near-real-time sync of recovery, strain, sleep, and the underlying
heart-rate / HRV signals. Unlike Withings, WHOOP credentials are
brought per user: each user (or the operator on their behalf)
registers their own WHOOP developer app and pastes the client
id/secret into Settings.

## Why bring your own keys

WHOOP caps the number of users a single developer app may authorise.
Per-user BYO-keys sidestep that per-app cap: every user authorises
against their own WHOOP app, so a shared HealthLog instance never
runs into one app's user ceiling. It also keeps each user's WHOOP
grant scoped to credentials they control.

## 1. Register a WHOOP developer app

1. Sign in at <https://developer.whoop.com/> and create a new app.
2. **Redirect URI:** `https://your-instance.example.com/api/whoop/callback`
   (matches `WHOOP_REDIRECT_URI`, below). Add one entry per
   environment you connect from.
3. Request the scopes for recovery, cycle/strain, sleep, and the
   workout/heart-rate reads the sync uses.
4. Save the app. WHOOP issues a **Client ID** and **Client Secret** —
   keep the secret out of any chat log; it grants read access to the
   linked account's full WHOOP history.

## 2. Wire the credentials in Settings → Integrations

WHOOP credentials are stored per user, not in `.env`. Sign in as the
target user, open **Settings → Integrations → WHOOP**, and paste the
client ID and secret. They are encrypted AES-256-GCM at rest.

## 3. Connect

Click **Connect WHOOP**. The flow:

1. The Connect button redirects to WHOOP's OAuth authorize endpoint.
2. The user signs in on WHOOP and grants the requested scopes.
3. WHOOP redirects back to `/api/whoop/callback` with an auth code.
4. HealthLog exchanges the code for an access + refresh token, stores
   them encrypted, registers the webhook, and triggers an initial
   sync of recent history.
5. Subsequent syncs run on every webhook delivery plus a safety-net
   cron pull.

## Optional instance env vars

Two server-level env vars tune the OAuth callback and webhook
verification. They are optional — the per-user client id/secret in
Settings drive the connection itself.

```env
WHOOP_REDIRECT_URI="https://your-instance.example.com/api/whoop/callback"
WHOOP_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

- `WHOOP_REDIRECT_URI` — the OAuth callback URL handed to WHOOP. Must
  match a redirect URI registered in the WHOOP developer app.
- `WHOOP_WEBHOOK_SECRET` — the secret HealthLog verifies the WHOOP
  webhook HMAC signature against. WHOOP signs each webhook body; the
  handler validates the signature before processing. Generate a fresh
  random value and restart the `app` container after setting it.

## Disconnect

The Settings page **Disconnect** button revokes the stored tokens and
removes the connection. Existing measurements synced from WHOOP stay
in the database — disconnect does not delete data.
