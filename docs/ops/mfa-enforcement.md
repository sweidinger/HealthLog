# Require a second factor (operator)

The admin settings expose a **Require a second factor** policy — instance-wide
under General settings, and as a per-user override on the user detail page. The
effective requirement for an account is the OR of the per-user override and the
instance-wide policy.

## What enforcement does — and does not — do

Enforcement is a **guidance nudge for web sessions, not a hard API wall.**

- When the policy is on, any account that signs in **on the web** without an
  active second factor is redirected to enrollment after authentication. It
  cannot reach the rest of the app until it enrolls.
- Enforcement does **not** block direct API or native (Bearer-token) access for
  an account that has not yet enrolled. A token-authenticated client keeps
  working until the user enrolls a factor of their own accord.

This is deliberate. A hard API wall on a not-yet-enrolled account would lock a
native client (or an automation using a long-lived token) out of its own data
with no in-band way to enrol, and there is no server-side path to mint a second
factor on the user's behalf. The step-up gates that protect destructive actions
(MFA disable, recovery-code regeneration, account deletion, encrypted export)
remain cookie-only and are unaffected by this policy — they apply to accounts
that have actually enrolled a factor.

## Operator guidance

- Treat the policy as a strong prompt that drives adoption, not as a control
  that retroactively secures every transport.
- To hard-gate a specific account's API access, the lever is the account
  itself (disable it, or rotate/revoke its tokens), not the MFA-required flag.
- The redirect clears the moment the user completes enrollment; no operator
  action is needed afterwards.
