# Google Health integration (Fitbit & Pixel)

> **Beta.** Field mapping is still being verified against live Google Health
> accounts, so some values may be missing or change in a future update.

HealthLog reads Fitbit and Pixel Watch data through the **Google Health API**.
The OAuth app is therefore a **Google Cloud** OAuth client — not a Fitbit
developer-console app. Like WHOOP, credentials are brought per user: each user
registers their own Google Cloud OAuth client and pastes the client id/secret
into Settings. The internal integration key is `fitbit`.

## 1. Create a Google Cloud OAuth client

1. In <https://console.cloud.google.com> create (or pick) a project and, under
   **APIs & Services**, enable the **Google Health API**.
2. Configure the OAuth consent screen for the project.
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** of
   type **Web application**.
4. **Authorized redirect URI:**
   `https://your-instance.example.com/api/fitbit/callback`
5. Save. Google issues a **Client ID** and **Client Secret** — keep the secret
   out of any chat log.

## 2. Scopes

HealthLog requests exactly these read-only scopes:

```
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
```

Location and intraday scopes are deliberately omitted to keep the
Restricted-scope review surface minimal. The authorize request sends
`access_type=offline` + `prompt=consent` — Google's requirement to issue a
refresh token (the equivalent of WHOOP's `offline` scope).

## 3. Wire the credentials in Settings → Integrations

Credentials are stored per user, not in `.env`. Sign in as the target user, open
**Settings → Integrations → Google Health**, and paste the client ID and secret.
They are encrypted AES-256-GCM at rest.

## 4. Connect

Click **Connect with Google Health**. HealthLog redirects to Google's OAuth
consent screen, exchanges the returned code for an access + refresh token, stores
them encrypted, and runs an initial sync. There is **no webhook** — Google Health
syncs on the safety-net cron pull.

## Redirect URI is validated strictly

The resolved `redirect_uri` is asserted at connect time to be absolute, `https`
(or `http` on localhost), to target exactly `/api/fitbit/callback`, and — when
`FITBIT_REDIRECT_URI` is set alongside `NEXT_PUBLIC_APP_URL` — to share its
origin. A misconfigured value fails closed rather than redirecting elsewhere.

## Optional instance env var

```env
# Only when the callback origin differs from NEXT_PUBLIC_APP_URL:
FITBIT_REDIRECT_URI="https://your-instance.example.com/api/fitbit/callback"
```

The Google Cloud client id/secret are per-user (Settings), not env vars.

## Source overlap

If Google Health and another source (Withings, WHOOP, Apple Health) both supply
the same vital — resting heart rate, blood oxygen, body temperature or
respiratory rate — you may see both values until a future update settles on a
single preferred source.

## Disconnect

The Settings **Disconnect** button revokes the stored tokens and removes the
connection. Previously synced measurements stay in the database.
