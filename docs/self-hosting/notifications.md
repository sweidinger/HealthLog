# Notifications — push channels for a self-host

HealthLog delivers reminders (medication doses, mood check-ins, personal
records) and a few operational alerts through a small cascade of push
channels. The single message to take away: **you do not need an Apple
Developer account or APNs to get push.** Three of the four channels are
free, work in the browser or in a messaging app you already have, and
cover every platform a self-hoster runs. APNs is only for the optional
native iOS app.

When an event fires, the dispatcher fans it out to every channel a user
has enabled, in a fixed order — APNs first, then Telegram, then ntfy,
then Web Push as the universal fallback
(`src/lib/notifications/dispatcher.ts`). Each channel is best-effort and
independent: a user can enable one, two, or all four, and a failure on
one never blocks the others.

## TL;DR — which channel needs what

| Channel | What it needs | Cost | Where it works |
| --- | --- | --- | --- |
| **Web Push** | A VAPID keypair (one command, or paste into the admin panel) | Free | Any modern desktop/Android browser; the installed PWA on iPhone (iOS 16.4+, after *Add to Home Screen*) |
| **Telegram** | A bot token from @BotFather + each user's chat ID | Free | Anywhere the Telegram app runs |
| **ntfy** | A topic on `ntfy.sh` or your own ntfy server | Free | The ntfy app (iOS/Android) or any browser |
| **APNs** | An Apple Developer account + a `.p8` push key | Apple Developer Program (paid) | The native iOS app only (TestFlight / App Store) |

Web Push is the recommended default — it needs no third-party account,
just a keypair you generate yourself once.

## Web Push (recommended default)

Web Push delivers notifications straight to a browser — desktop or
mobile — even when the HealthLog tab is closed, as long as the browser
or installed PWA is alive. It is the broadest-reach channel and the one
to set up first.

### 1. Generate a VAPID keypair

VAPID is the signing scheme that lets a push service trust your server.
Generate a keypair once with the bundled `web-push` CLI:

```bash
npx web-push generate-vapid-keys
```

That prints a **public key** and a **private key** (both Base64URL). You
also choose a **subject** — a `mailto:` address the push service can
contact about your sender, e.g. `mailto:you@example.com`.

### 2. Store the keys

The server loads VAPID config from the database first and falls back to
environment variables (`src/lib/notifications/vapid-config.ts`). Either
path works; the admin panel is the easier one because it survives without
touching `.env`.

**Admin panel (preferred).** Sign in as the admin user, open
`/admin`, and find the **Web Push VAPID** card
(`src/components/admin/web-push-vapid-section.tsx`). Paste the public key,
the private key, and the subject, then save. The private key is encrypted
at rest with your `ENCRYPTION_KEY`, exactly like the other secrets in the
admin panel. The card shows a "configured" badge once all three fields
are set.

**Environment variables (alternative).** If you would rather keep
secrets out of the database, set them in `.env` / the compose
`environment:` block instead:

```env
VAPID_PUBLIC_KEY="BElx...(public key)"
VAPID_PRIVATE_KEY="...(private key)"
VAPID_SUBJECT="mailto:you@example.com"
```

The database values win when both are present. The loader also accepts a
few aliases (`WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_PUBLIC_KEY`, and the
private/subject equivalents) so a config copied from another deployment
keeps working.

### 3. Subscribe a device

Each user enables Web Push for their own browser from
`/settings/notifications` — the **Browser Push** card has a Subscribe
button, and a Test button to fire a one-off push once subscribed. The
browser prompts for notification permission on first subscribe; once
granted, that browser receives every enabled event.

### iPhone caveat — Add to Home Screen first

Safari on iPhone supports Web Push only from **iOS 16.4 or newer**, and
only for a site that has been **installed to the Home Screen as a PWA**.
A regular Safari tab cannot subscribe. So on iPhone:

1. Open your HealthLog instance in Safari.
2. Tap the Share button, then **Add to Home Screen**.
3. Launch HealthLog from the new Home Screen icon (not from the Safari
   tab).
4. Open `/settings/notifications` inside that installed app and tap
   Subscribe; accept the permission prompt.

Android and desktop browsers have no such step — Subscribe and grant the
permission, and push works.

## Telegram

Telegram delivers reminders as bot messages, with inline action buttons
on medication reminders (Taken / snooze / skip). It is a good fit when
you already live in Telegram or want push without running a browser.

1. In Telegram, open **@BotFather**, create a bot, and copy the **bot
   token** (it looks like `123456:ABC-DEF...`).
2. Send `/start` to your new bot so it can message you.
3. Find your **chat ID** — send a message to **@userinfobot**, or read it
   from the Bot API.
4. In HealthLog open `/settings/notifications`, fill the Telegram card's
   **Bot Token** and **Chat ID**, toggle it on, and save.

One bot can serve every user on the instance; each user pairs their own
chat ID. The token is encrypted at rest.

## ntfy

[ntfy](https://ntfy.sh) is the most self-hoster-native option: a tiny
pub/sub push relay you can use hosted (`ntfy.sh`) or run yourself. You
subscribe to a **topic** in the ntfy app (iOS/Android) or a browser, and
HealthLog publishes to that topic.

1. Pick a hard-to-guess topic name (the topic *is* the access control on
   public `ntfy.sh` — anyone who knows the string can read it, so treat
   it like a secret).
2. Subscribe to that topic in the ntfy app or at `https://ntfy.sh/<topic>`.
3. In HealthLog open `/settings/notifications`, set the ntfy card's
   **Server URL** (defaults to `https://ntfy.sh`; point it at your own
   server if you self-host ntfy) and **Topic**, then save.

If your ntfy server requires auth, an access token can be attached; the
server URL is validated as a public host and dialled through the egress
guard (`src/lib/notifications/senders/ntfy.ts`).

## APNs — native iOS app only

Apple Push Notification service is used by **only** the native SwiftUI
iOS app (TestFlight / App Store build). PWA and browser users never touch
it. Setting it up requires a paid **Apple Developer Program** membership.

You do **not** need APNs to give iPhone users push: the installed PWA
gets every reminder over Web Push (see the iPhone caveat above). APNs adds
one Apple-platform exclusive the PWA cannot offer — the lock-screen Live
Activity — plus the tighter native delivery path. Reminders themselves
arrive on both.

If you do run the native app and want server-driven push, set the APNs
manifest (`src/lib/notifications/senders/apns.ts`) — three identifiers
plus exactly one key source:

| Variable | Purpose |
| --- | --- |
| `APNS_KEY_ID` | The `.p8` key's Key ID |
| `APNS_TEAM_ID` | Your Apple Developer Team ID |
| `APNS_BUNDLE_ID` | The app's bundle identifier |
| `APNS_KEY_B64` | The `.p8` PEM, base64-encoded (recommended key source) |
| `APNS_KEY` | OR the raw PEM body inline |
| `APNS_KEY_FILE` | OR a path to the `.p8` file |

APNs is **all-or-none**: either set the three IDs plus one key source, or
leave the whole block unset. A partial config is rejected so the channel
never silently half-works (`scripts/check-env.ts`). When more than one key
source is present, the precedence is `APNS_KEY_B64` > `APNS_KEY` >
`APNS_KEY_FILE`.

Two gotchas worth knowing before you blame a stale token:

- **Base64 the key.** Pasting a raw `.p8` PEM through some env-file
  pipelines mangles its line breaks. `APNS_KEY_B64` (the PEM body,
  base64-encoded) sidesteps that entirely and is the recommended source.
- **Scope the key "Sandbox & Production".** In the Apple Developer
  Portal, a push key defaults to Sandbox-only. A Sandbox-only key fails
  on production (TestFlight / App Store) device tokens with
  `BadEnvironmentKeyInToken`. Confirm the key shows **Sandbox &
  Production**; a wrongly scoped key cannot be reconfigured — re-issue it.

## Which channel should I pick?

| Your setup | Recommended channel |
| --- | --- |
| PWA on Android or desktop | **Web Push** — generate a VAPID keypair, subscribe, done. |
| PWA on an iPhone | **Web Push**, but install the PWA via *Add to Home Screen* first (iOS 16.4+). Reminders work; the lock-screen Live Activity needs the native app. |
| You want the native iOS app's full experience | **APNs** (paid Apple Developer account) *plus* Web Push as a fallback for any non-iOS device. |
| Headless / no browser, or you live in chat | **Telegram** or **ntfy** — neither needs a browser, both are free. ntfy is the most self-host-native; Telegram adds inline reminder action buttons. |

Mixing channels is fine and common — e.g. Web Push on the laptop and
ntfy on the phone. Each user configures their own set from
`/settings/notifications`.
