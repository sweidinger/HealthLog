# Google Health / Fitbit integration

> **This page moved.** HealthLog connects Fitbit and Pixel Watch data through the
> classic **Fitbit Web API** (an app registered at
> [dev.fitbit.com](https://dev.fitbit.com/apps/new)), **not** through a Google
> Cloud OAuth client. If you were told to create a Google Cloud client and hit
> `unauthorized_client — Invalid client_id`, that is why.

See **[Fitbit integration (Fitbit & Pixel)](./fitbit.md)** for the correct setup.

Background: Google is retiring the classic Fitbit Web API in September 2026 in
favour of the Google Health API behind Google sign-in. That replacement requires
Restricted-scope brand verification plus an annual CASA security assessment,
which does not currently fit a self-hosted bring-your-own-credentials model, so
until the sunset the Fitbit developer-app path documented above is the supported
way to connect.
