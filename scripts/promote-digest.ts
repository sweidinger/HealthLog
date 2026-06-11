/**
 * promote-digest.ts — pin a released image to its immutable digest.
 *
 * After `docker-publish.yml` pushes `vX.Y.Z` (+ `:latest`) to GHCR, this
 * script turns the mutable tag into a deterministic deploy reference:
 *
 *   1. Resolves the multi-arch index digest for the tag straight from
 *      the GHCR registry API (anonymous pull token — the image is
 *      public; no docker daemon needed).
 *   2. Verifies the keyless cosign signature the publish workflow
 *      attached to that digest (GitHub Actions OIDC identity). Fails
 *      closed: no cosign binary or a failed verification aborts the
 *      promotion.
 *   3. Emits the `HEALTHLOG_IMAGE_REF=@sha256:…` value the compose
 *      file interpolates into `image:` — and, when a Coolify API token
 *      is present in the environment, writes it to the application's
 *      env vars via the documented `/envs` endpoint. Without a token
 *      it prints the exact curl commands instead of guessing.
 *
 * Why an env var and not the compose file itself: for a git-based
 * "Docker Compose" application Coolify re-reads the compose file from
 * the repository checkout on every deploy (`docker_compose_raw` is its
 * stored copy of that file and is not part of the application-update
 * API surface), so editing the stored compose is not durable. The
 * application env vars ARE durable and are interpolated into the
 * compose at deploy time — `image: ghcr.io/mbombeck/healthlog${HEALTHLOG_IMAGE_REF:-:latest}`
 * resolves to the pinned digest when the var is set and to `:latest`
 * when it is not.
 *
 * Usage (one-shot, not a recurring job):
 *   pnpm dlx tsx scripts/promote-digest.ts v1.16.5
 *
 * Env (all optional — without them the script prints commands only):
 *   COOLIFY_API_TOKEN   API token (Coolify → Keys & Tokens → API tokens)
 *   COOLIFY_API_URL     Base URL of the Coolify instance, e.g. https://coolify.example.com
 *   COOLIFY_APP_UUID    UUID of the HealthLog application resource
 *   PROMOTE_DEPLOY=1    Additionally trigger a deploy after the env update
 *
 * See docs/ops/deploy.md ("Digest pinning") for the full runbook,
 * including rollback (re-point the var at the previous digest).
 */

import { execFileSync } from "node:child_process";

const IMAGE_REPO = "mbombeck/healthlog";
const IMAGE = `ghcr.io/${IMAGE_REPO}`;
const ENV_KEY = "HEALTHLOG_IMAGE_REF";
const COSIGN_ISSUER = "https://token.actions.githubusercontent.com";
const COSIGN_IDENTITY_RE = "^https://github.com/MBombeck/HealthLog/";

// The OCI index media types a multi-arch publish can produce. GHCR
// answers the manifest request with the digest of whichever it stores;
// accepting both keeps the script working across buildx versions.
const INDEX_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function resolveDigest(tag: string): Promise<string> {
  // Anonymous pull token — the package is public, so no credentials.
  const tokenRes = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${IMAGE_REPO}:pull`,
  );
  if (!tokenRes.ok) {
    fail(`GHCR token request failed: HTTP ${tokenRes.status}`);
  }
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) fail("GHCR token response carried no token");

  // HEAD is enough — the digest rides the Docker-Content-Digest header.
  const manifestRes = await fetch(
    `https://ghcr.io/v2/${IMAGE_REPO}/manifests/${encodeURIComponent(tag)}`,
    {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}`, Accept: INDEX_ACCEPT },
    },
  );
  if (!manifestRes.ok) {
    fail(
      `manifest lookup for ${IMAGE}:${tag} failed: HTTP ${manifestRes.status} — does the tag exist on GHCR?`,
    );
  }
  const digest = manifestRes.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    fail(`registry returned no usable digest (got: ${digest ?? "nothing"})`);
  }
  return digest;
}

function verifyCosign(digest: string): void {
  const ref = `${IMAGE}@${digest}`;
  try {
    execFileSync(
      "cosign",
      [
        "verify",
        "--certificate-oidc-issuer",
        COSIGN_ISSUER,
        "--certificate-identity-regexp",
        COSIGN_IDENTITY_RE,
        ref,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") {
      fail(
        "cosign binary not found. Install it (https://docs.sigstore.dev/cosign/system_config/installation/) — the promotion fails closed without signature verification.",
      );
    }
    fail(
      `cosign verification FAILED for ${ref} — do not deploy this digest.\n${e.stderr?.toString() ?? ""}`,
    );
  }
  console.log(`cosign signature verified for ${ref}`);
}

interface CoolifyEnvRow {
  uuid: string;
  key: string;
  value?: string;
}

async function coolifyRequest(
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${base.replace(/\/$/, "")}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

async function updateCoolifyEnv(
  base: string,
  token: string,
  appUuid: string,
  value: string,
): Promise<void> {
  const list = await coolifyRequest(base, token, `/applications/${appUuid}/envs`);
  if (!list.ok) {
    fail(`Coolify env list failed: HTTP ${list.status} — check token/UUID`);
  }
  const rows = (await list.json()) as CoolifyEnvRow[];
  const existing = Array.isArray(rows)
    ? rows.find((r) => r.key === ENV_KEY)
    : undefined;

  const method = existing ? "PATCH" : "POST";
  const res = await coolifyRequest(
    base,
    token,
    `/applications/${appUuid}/envs`,
    { method, body: JSON.stringify({ key: ENV_KEY, value }) },
  );
  if (!res.ok) {
    fail(`Coolify env ${method} failed: HTTP ${res.status}`);
  }
  console.log(
    `Coolify env ${ENV_KEY} ${existing ? "updated" : "created"} (was: ${existing?.value ?? "unset"})`,
  );
}

async function triggerDeploy(
  base: string,
  token: string,
  appUuid: string,
): Promise<void> {
  const res = await coolifyRequest(base, token, `/deploy?uuid=${appUuid}`);
  if (!res.ok) fail(`deploy trigger failed: HTTP ${res.status}`);
  console.log("Deploy triggered. Verify /api/version after it settles.");
}

function printManualCommands(value: string): void {
  console.log(`
No COOLIFY_API_TOKEN in the environment — manual path (fill in host,
token and application UUID; the UUID is in the Coolify URL of the app):

  # set / update the pin (POST creates, PATCH updates an existing key)
  curl -sS -X PATCH "https://<coolify-host>/api/v1/applications/<app-uuid>/envs" \\
    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\
    -d '{"key":"${ENV_KEY}","value":"${value}"}'

  # redeploy with the pinned digest
  curl -sS "https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>" \\
    -H "Authorization: Bearer <token>"
`);
}

async function main(): Promise<void> {
  const tag = process.argv[2];
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
    fail("usage: pnpm dlx tsx scripts/promote-digest.ts vX.Y.Z");
  }

  console.log(`Resolving multi-arch digest for ${IMAGE}:${tag} …`);
  const digest = await resolveDigest(tag);
  console.log(`digest: ${digest}`);

  verifyCosign(digest);

  const value = `@${digest}`;
  console.log(`\n${ENV_KEY}=${value}`);

  const token = process.env.COOLIFY_API_TOKEN;
  const base = process.env.COOLIFY_API_URL;
  const appUuid = process.env.COOLIFY_APP_UUID;

  if (token && base && appUuid) {
    await updateCoolifyEnv(base, token, appUuid, value);
    if (process.env.PROMOTE_DEPLOY === "1") {
      await triggerDeploy(base, token, appUuid);
    } else {
      console.log(
        "Env updated only — trigger the deploy from Coolify (or re-run with PROMOTE_DEPLOY=1).",
      );
    }
  } else {
    if (token || base || appUuid) {
      console.log(
        "Partial Coolify config — need COOLIFY_API_TOKEN + COOLIFY_API_URL + COOLIFY_APP_UUID together; printing the manual path instead.",
      );
    }
    printManualCommands(value);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
