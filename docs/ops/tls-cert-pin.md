# TLS leaf SPKI pin — coupling, alarm, and re-pin runbook

The native client SPKI-pins the server's TLS **leaf** certificate. This is a
deliberate hardening choice on the client side, but it couples the client to
the exact leaf keypair the server serves: when that leaf rotates, a client
that was only ever shipped the old pin refuses to connect. This page explains
the coupling, the server-side alarm that watches for a rotation, and the
operator / release-owner steps when it fires.

## The coupling

A SPKI pin is `base64(sha256(DER subjectPublicKeyInfo))` — a hash of the
certificate's public key, not of the whole certificate. The native client
carries a set of these pins and rejects any TLS connection whose leaf public
key is not in the set.

The app host's certificate is issued by Google Trust Services (GTS) and
auto-renews roughly every 90 days. Each renewal mints a **new leaf keypair**,
so the SPKI pin changes on every renewal. Intermediate and root rolls have
the same effect on the leaf chain. Because the client pins the leaf, every
such change is a hard outage for any client that hasn't been shipped the new
pin — and there is otherwise no server-side signal that a client is pinning
the served leaf at all.

## The alarm

A scheduled job (`src/lib/jobs/tls-pin-monitor.ts`) probes the served leaf
every 6 hours and fails loudly when it changes:

- It derives the public host from `APP_URL` (falling back to
  `NEXT_PUBLIC_APP_URL`) and opens a raw TLS socket to it — observing exactly
  the certificate a pinned client would, regardless of how the reverse proxy
  terminates TLS.
- It reads the served leaf, computes its SPKI pin
  (`base64(sha256(DER subjectPublicKeyInfo))`), and compares it against the
  operator's known-good set in `TLS_LEAF_SPKI_PINS`.
- On a served pin that is **not** in the known set it emits a
  `tls.pin.leaf_changed` wide-event annotation (old set + served pin), writes
  a `system.tls.pin_changed` audit-log row, and fans out a high-priority
  `SYSTEM_ALERT` to every admin user through the notification dispatcher
  (Telegram / ntfy / Web Push / APNs, whichever the operator has wired).

A transient TLS or network failure during the probe is annotated
(`tls.pin.probe_failed`) and never alarms — the alarm fires only on a
successful probe returning a pin genuinely outside the known set.

### Baseline source: an env var, not auto-learning

`TLS_LEAF_SPKI_PINS` (comma-separated) is the known-good set. The baseline is
an env var on purpose, **not** a persisted "last-seen" row:

- The pinned client only trusts the pins it was shipped, so the operator must
  derive the client's pin set from a single explicit source of truth. The env
  var **is** that source — the same value goes into the client's pin set and
  into `TLS_LEAF_SPKI_PINS`.
- A persisted last-seen baseline would silently adopt the first rotated pin
  and suppress the very alarm the pinned client needs.
- When the env var is unset, the monitor fails **loud, not open**: it logs
  the served pin (so you can seed the baseline) and warns "not configured",
  but never auto-adopts what it observed.

## Setting the baseline

Extract the current leaf SPKI pin from the served certificate:

```sh
openssl s_client -connect "$APP_HOST:443" -servername "$APP_HOST" </dev/null 2>/dev/null \
  | openssl x509 -noout -pubkey \
  | openssl pkey -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | openssl base64
```

`$APP_HOST` is the host in your configured `APP_URL` (the host the client
connects to). The output is the `base64(sha256(DER subjectPublicKeyInfo))`
pin. Set it in the deployment env:

```
TLS_LEAF_SPKI_PINS="<current-leaf-pin>"
```

The variable is on the compose `environment:` whitelist and the
`scripts/env-manifest.json` optional groups, so `pnpm check-env` will report
whether it is set. It is optional: without it the monitor still runs and logs
the served pin, but cannot alarm on a change.

## When the alarm fires — re-pin procedure

When you see a `tls.pin.leaf_changed` alert / `system.tls.pin_changed` audit
row, the served leaf has rotated. The pinned client will stop connecting once
its shipped pin no longer matches a served leaf. Act inside the certificate's
remaining validity, with margin for app review and client roll-out — target
**≥ 11 days before the old pin's certificate expires** (the alert body and
audit row both carry the new leaf's `validTo`).

1. **Re-extract the new leaf pin** with the `openssl` pipeline above. It
   should equal the `servedPin` in the alert.
2. **Dual-pin.** Add the new pin to the client's pin set **alongside** the old
   one (do not replace it yet), and update `TLS_LEAF_SPKI_PINS` to the
   comma-separated pair, e.g.
   `TLS_LEAF_SPKI_PINS="<old-pin>,<new-pin>"`. Holding both pins means clients
   on the old build keep working through the cutover and the server-side
   alarm goes quiet because the served pin is now in the known set. Re-deploy
   the server so the new env value takes effect.
3. **Ship the client build** carrying the dual-pin set to TestFlight (and
   onward to release). Give it long enough to roll out to the installed base
   before the next renewal.
4. **Retire the old pin** once the old leaf is no longer served and the
   dual-pinned client build has reached the installed base: drop the old pin
   from both the client pin set and `TLS_LEAF_SPKI_PINS`, leaving only the
   current leaf pin.

Treat the dual-pin window as standing practice: always ship the **next** pin
before the current leaf rotates, so a renewal never catches a single-pinned
client. If GTS renews on a fixed cadence, pre-extracting and dual-pinning the
upcoming leaf ahead of the renewal turns every rotation into a no-op.

## Environment assumption

The monitor speaks TLS directly to the public host from `APP_URL` /
`NEXT_PUBLIC_APP_URL`, which is correct regardless of the reverse-proxy
topology — it observes the same leaf a real client does. The one assumption
is that the host the client connects to is the host in that env var. If the
client is pinned against a different hostname (e.g. a vanity domain that
fronts the configured `APP_URL`), point the monitor at that host by setting
`APP_URL` to it, or extend the job to probe the additional host. Plain-HTTP
self-hosts have no leaf to pin and the monitor no-ops there by design.
